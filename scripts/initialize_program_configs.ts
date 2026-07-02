import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import "dotenv/config";
import { loadKeypair } from "./utils";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";

type ConfigRecord = {
  pda: string;
  initialized: boolean;
  authority?: string;
  signature?: string;
  unitsConsumed?: number;
};

type InitArtifact = {
  createdAt: string;
  executed: boolean;
  rpcUrl: string;
  payer: string;
  configAuthority: string;
  vaultProgram: string;
  queueProgram: string;
  configs: {
    vault?: ConfigRecord;
    queue?: ConfigRecord;
  };
};

function envBool(name: string, defaultValue = false): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

function writeArtifact(artifactPath: string, artifact: InitArtifact) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n");
}

function redactRpcUrl(rpcUrl: string): string {
  try {
    const url = new URL(rpcUrl);
    const hasSensitivePath = url.pathname && url.pathname !== "/";
    url.pathname = hasSensitivePath ? "/<redacted>" : url.pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return rpcUrl;
  }
}

function loadProgramSigner(
  envName: string,
  defaultPath: string,
  programId: PublicKey
) {
  const keypairPath = process.env[envName] || defaultPath;
  const signer = loadKeypair(keypairPath);
  if (!signer.publicKey.equals(programId)) {
    throw new Error(
      `${envName} public key mismatch: expected ${programId.toBase58()}, got ${signer.publicKey.toBase58()} from ${keypairPath}`
    );
  }
  return signer;
}

function idlPath(idlName: string): string {
  return path.resolve(__dirname, "..", "target", "idl", `${idlName}.json`);
}

function readIdlProgramId(idlName: string): PublicKey {
  const file = idlPath(idlName);
  if (!fs.existsSync(file)) {
    throw new Error(`Missing ${file}. Run anchor build before this script.`);
  }
  const idl = JSON.parse(fs.readFileSync(file, "utf8"));
  const address = idl.address || idl.metadata?.address;
  if (!address) {
    throw new Error(`IDL ${file} does not contain an address.`);
  }
  return new PublicKey(address);
}

function loadProgram(
  idlName: string,
  programId: PublicKey,
  provider: anchor.AnchorProvider
): Program<any> {
  const file = idlPath(idlName);
  const idl = JSON.parse(fs.readFileSync(file, "utf8"));
  idl.address = programId.toBase58();
  idl.metadata = { ...(idl.metadata || {}), address: programId.toBase58() };
  return new anchor.Program(idl, provider);
}

async function waitForConfirmation(signature: string, connection: Connection) {
  for (let i = 0; i < 90; i++) {
    const result = await connection.getSignatureStatus(signature);
    if (
      result?.value?.confirmationStatus === "confirmed" ||
      result?.value?.confirmationStatus === "finalized"
    ) {
      return;
    }
    if (result?.value?.err) {
      throw new Error(
        `Transaction failed: ${JSON.stringify(result.value.err)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Transaction confirmation timed out: ${signature}`);
}

async function simulateAndMaybeSend(args: {
  label: string;
  instruction: TransactionInstruction;
  connection: Connection;
  payer: anchor.web3.Keypair;
  additionalSigners?: anchor.web3.Keypair[];
  execute: boolean;
}): Promise<{ signature?: string; unitsConsumed?: number }> {
  const { label, instruction, connection, payer, additionalSigners, execute } =
    args;
  const tx = new Transaction().add(instruction);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, ...(additionalSigners || []));

  console.log(`Simulating ${label}...`);
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) {
    console.error(simulation.value.logs?.join("\n"));
    throw new Error(
      `${label} simulation failed: ${JSON.stringify(simulation.value.err)}`
    );
  }

  if (!execute) {
    console.log(`Simulation passed for ${label}.`);
    return { unitsConsumed: simulation.value.unitsConsumed || undefined };
  }

  console.log(`Sending ${label}...`);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await waitForConfirmation(signature, connection);
  console.log(`${label} confirmed: ${signature}`);
  return {
    signature,
    unitsConsumed: simulation.value.unitsConsumed || undefined,
  };
}

async function initializeConfigIfNeeded(args: {
  label: "vault" | "queue";
  program: Program<any>;
  connection: Connection;
  payer: anchor.web3.Keypair;
  programSigner: anchor.web3.Keypair;
  configAuthority: PublicKey;
  execute: boolean;
  artifact: InitArtifact;
  artifactPath: string;
}) {
  const {
    label,
    program,
    connection,
    payer,
    programSigner,
    configAuthority,
    execute,
    artifact,
    artifactPath,
  } = args;
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  );

  const existing = await connection.getAccountInfo(configPda, "confirmed");
  if (existing) {
    const config = await (program.account as any).programConfig.fetch(
      configPda
    );
    const authority = config.authority as PublicKey;
    if (!authority.equals(configAuthority)) {
      throw new Error(
        `${label} config authority mismatch: expected ${configAuthority.toBase58()}, got ${authority.toBase58()}`
      );
    }
    artifact.configs[label] = {
      pda: configPda.toBase58(),
      initialized: true,
      authority: authority.toBase58(),
    };
    writeArtifact(artifactPath, artifact);
    console.log(`${label} config already initialized: ${configPda.toBase58()}`);
    return;
  }

  const ix = await (program.methods as any)
    .initialize(configAuthority)
    .accounts({
      signer: payer.publicKey,
      program: program.programId,
      config: configPda,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();

  const result = await simulateAndMaybeSend({
    label: `initialize${label[0].toUpperCase()}${label.slice(1)}Config`,
    instruction: ix,
    connection,
    payer,
    additionalSigners: [programSigner],
    execute,
  });

  artifact.configs[label] = {
    pda: configPda.toBase58(),
    initialized: execute,
    authority: configAuthority.toBase58(),
    signature: result.signature,
    unitsConsumed: result.unitsConsumed,
  };
  writeArtifact(artifactPath, artifact);
}

async function main() {
  const execute = envBool("EXECUTE", false);
  if (execute && !envBool("CONFIRM_PROGRAM_CONFIG_INIT", false)) {
    throw new Error(
      "Set CONFIRM_PROGRAM_CONFIG_INIT=true to initialize live program configs."
    );
  }

  const rpcUrl =
    process.env.SPYX_RPC_URL ||
    process.env.ANCHOR_PROVIDER_URL ||
    process.env.SOLANA_RPC_URL ||
    DEFAULT_RPC_URL;
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) {
    throw new Error(
      "ANCHOR_WALLET must point to the fee-payer/config authority keypair JSON."
    );
  }

  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000,
    disableRetryOnRateLimit: false,
  });
  const payer = loadKeypair(walletPath);
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(payer),
    { commitment: "confirmed", skipPreflight: false }
  );
  anchor.setProvider(provider);

  const genesisHash = await connection.getGenesisHash();
  if (
    genesisHash !== MAINNET_GENESIS_HASH &&
    !envBool("SKIP_MAINNET_CHECK", false)
  ) {
    throw new Error(
      `RPC is not Solana mainnet-beta (genesis ${genesisHash}). Set SKIP_MAINNET_CHECK=true to override.`
    );
  }

  const vaultProgramId = new PublicKey(
    process.env.BORING_VAULT_PROGRAM_ID || readIdlProgramId("boring_vault_svm")
  );
  const queueProgramId = new PublicKey(
    process.env.BORING_QUEUE_PROGRAM_ID ||
      readIdlProgramId("boring_onchain_queue")
  );
  const configAuthority = new PublicKey(
    process.env.PROGRAM_CONFIG_AUTHORITY || payer.publicKey
  );

  const vaultProgram = loadProgram(
    "boring_vault_svm",
    vaultProgramId,
    provider
  );
  const queueProgram = loadProgram(
    "boring_onchain_queue",
    queueProgramId,
    provider
  );
  const vaultProgramSigner = loadProgramSigner(
    "VAULT_PROGRAM_KEYPAIR",
    path.resolve(
      __dirname,
      "..",
      "target",
      "deploy",
      "boring_vault_svm-keypair.json"
    ),
    vaultProgram.programId
  );
  const queueProgramSigner = loadProgramSigner(
    "QUEUE_PROGRAM_KEYPAIR",
    path.resolve(
      __dirname,
      "..",
      "target",
      "deploy",
      "boring_onchain_queue-keypair.json"
    ),
    queueProgram.programId
  );

  for (const [label, programId] of [
    ["vault", vaultProgram.programId],
    ["queue", queueProgram.programId],
  ] as const) {
    const programInfo = await connection.getAccountInfo(programId, "confirmed");
    if (!programInfo?.executable) {
      throw new Error(
        `${label} program is not executable: ${programId.toBase58()}`
      );
    }
  }

  const artifactName = `program-config-init-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}${execute ? "" : "-dry-run"}.json`;
  const artifactPath = path.resolve(
    process.env.DEPLOYMENT_OUT_DIR ||
      path.resolve(__dirname, "..", "deployments"),
    artifactName
  );
  const artifact: InitArtifact = {
    createdAt: new Date().toISOString(),
    executed: execute,
    rpcUrl: redactRpcUrl(rpcUrl),
    payer: payer.publicKey.toBase58(),
    configAuthority: configAuthority.toBase58(),
    vaultProgram: vaultProgram.programId.toBase58(),
    queueProgram: queueProgram.programId.toBase58(),
    configs: {},
  };
  writeArtifact(artifactPath, artifact);

  console.log("Program config initialization preflight:");
  console.log(`  execute: ${execute}`);
  console.log(`  payer: ${payer.publicKey.toBase58()}`);
  console.log(`  config authority: ${configAuthority.toBase58()}`);
  console.log(`  vault program: ${vaultProgram.programId.toBase58()}`);
  console.log(`  queue program: ${queueProgram.programId.toBase58()}`);
  console.log(`  artifact: ${artifactPath}`);

  await initializeConfigIfNeeded({
    label: "vault",
    program: vaultProgram,
    connection,
    payer,
    programSigner: vaultProgramSigner,
    configAuthority,
    execute,
    artifact,
    artifactPath,
  });
  await initializeConfigIfNeeded({
    label: "queue",
    program: queueProgram,
    connection,
    payer,
    programSigner: queueProgramSigner,
    configAuthority,
    execute,
    artifact,
    artifactPath,
  });

  console.log("Program config initialization completed.");
}

main().catch((error) => {
  console.error("Program config initialization failed:", error);
  process.exitCode = 1;
});
