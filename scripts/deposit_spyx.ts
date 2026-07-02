import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  getMint,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import fs from "fs";
import path from "path";
import "dotenv/config";
import { loadKeypair } from "./utils";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";
const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
const DEFAULT_VAULT_PROGRAM_ID = "FF1CvjpUwwbneBnpUogL1wTYt7pWvAchzdNiLB7vk7Au";
const DEFAULT_SPYX_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";
const DEFAULT_VAULT_ID = new anchor.BN(0);

type DepositArtifact = {
  createdAt: string;
  executed: boolean;
  rpcUrl: string;
  payer: string;
  vaultProgram: string;
  spyxMint: string;
  spyxTokenProgram?: string;
  spyxDecimals?: number;
  vaultId: string;
  vaultState?: string;
  boringVault?: string;
  shareMint?: string;
  userSpyxAta?: string;
  vaultSpyxAta?: string;
  userShareAta?: string;
  depositRawAmount?: string;
  depositUiAmount?: string;
  createdVaultAta?: boolean;
  signature?: string;
  unitsConsumed?: number;
  postUserSpyxRawAmount?: string;
  postVaultSpyxRawAmount?: string;
  postUserSharesRawAmount?: string;
};

function envBool(name: string, defaultValue = false): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
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

function writeArtifact(artifactPath: string, artifact: DepositArtifact) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n");
}

function loadProgram(
  idlName: string,
  programId: PublicKey,
  provider: anchor.AnchorProvider
): Program<any> {
  const idlPath = path.resolve(
    __dirname,
    "..",
    "target",
    "idl",
    `${idlName}.json`
  );
  if (!fs.existsSync(idlPath)) {
    throw new Error(`Missing ${idlPath}. Run anchor build before this script.`);
  }

  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  idl.address = programId.toBase58();
  idl.metadata = { ...(idl.metadata || {}), address: programId.toBase58() };
  return new anchor.Program(idl, provider);
}

function vaultIdToBuffer(vaultId: anchor.BN): Buffer {
  return vaultId.toArrayLike(Buffer, "le", 8);
}

function formatTokenAmount(rawAmount: bigint, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const whole = rawAmount / divisor;
  const fraction = rawAmount % divisor;
  if (fraction === 0n) return whole.toString();
  return `${whole}.${fraction
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "")}`;
}

async function fetchTokenAmount(args: {
  connection: Connection;
  account: PublicKey;
  tokenProgramId: PublicKey;
}) {
  const { connection, account, tokenProgramId } = args;
  const accountInfo = await connection.getAccountInfo(account, "confirmed");
  if (!accountInfo) return undefined;
  return (await getAccount(connection, account, "confirmed", tokenProgramId))
    .amount;
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
  instructions: TransactionInstruction[];
  connection: Connection;
  payer: anchor.web3.Keypair;
  execute: boolean;
}) {
  const { instructions, connection, payer, execute } = args;
  const tx = new Transaction().add(...instructions);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);

  console.log("Simulating SPYx deposit...");
  const simulation = await connection.simulateTransaction(tx);
  if (simulation.value.err) {
    console.error(simulation.value.logs?.join("\n"));
    throw new Error(
      `SPYx deposit simulation failed: ${JSON.stringify(simulation.value.err)}`
    );
  }

  if (!execute) {
    console.log("Simulation passed for SPYx deposit.");
    return { unitsConsumed: simulation.value.unitsConsumed || undefined };
  }

  console.log("Sending SPYx deposit...");
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  await waitForConfirmation(signature, connection);
  console.log(`SPYx deposit confirmed: ${signature}`);
  return {
    signature,
    unitsConsumed: simulation.value.unitsConsumed || undefined,
  };
}

async function main() {
  const execute = envBool("EXECUTE", false);
  if (execute && !envBool("CONFIRM_SPYX_DEPOSIT", false)) {
    throw new Error("Set CONFIRM_SPYX_DEPOSIT=true to send the live deposit.");
  }

  const rpcUrl =
    process.env.SPYX_RPC_URL ||
    process.env.ANCHOR_PROVIDER_URL ||
    process.env.SOLANA_RPC_URL ||
    DEFAULT_RPC_URL;
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) {
    throw new Error("ANCHOR_WALLET must point to the depositor keypair JSON.");
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
    process.env.BORING_VAULT_PROGRAM_ID || DEFAULT_VAULT_PROGRAM_ID
  );
  const spyxMint = new PublicKey(process.env.SPYX_MINT || DEFAULT_SPYX_MINT);
  const vaultId = process.env.VAULT_ID
    ? new anchor.BN(process.env.VAULT_ID)
    : DEFAULT_VAULT_ID;

  const vaultProgram = loadProgram(
    "boring_vault_svm",
    vaultProgramId,
    provider
  );
  const programInfo = await connection.getAccountInfo(
    vaultProgram.programId,
    "confirmed"
  );
  if (!programInfo?.executable) {
    throw new Error(
      `Vault program is not executable: ${vaultProgram.programId.toBase58()}`
    );
  }

  const spyxMintAccount = await connection.getAccountInfo(
    spyxMint,
    "confirmed"
  );
  if (!spyxMintAccount) {
    throw new Error(`SPYx mint not found: ${spyxMint.toBase58()}`);
  }
  const spyxTokenProgramId = spyxMintAccount.owner;
  if (
    !spyxTokenProgramId.equals(TOKEN_PROGRAM_ID) &&
    !spyxTokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    throw new Error(
      `SPYx mint owner is not an SPL token program: ${spyxTokenProgramId.toBase58()}`
    );
  }
  const spyxMintInfo = await getMint(
    connection,
    spyxMint,
    "confirmed",
    spyxTokenProgramId
  );

  const vaultIdBuffer = vaultIdToBuffer(vaultId);
  const [boringVaultState] = PublicKey.findProgramAddressSync(
    [Buffer.from("boring-vault-state"), vaultIdBuffer],
    vaultProgram.programId
  );
  const vaultState = await (vaultProgram.account as any).boringVault.fetch(
    boringVaultState
  );
  if (!(vaultState.teller.baseAsset as PublicKey).equals(spyxMint)) {
    throw new Error(
      `Vault base asset mismatch: expected ${spyxMint.toBase58()}, got ${vaultState.teller.baseAsset.toBase58()}`
    );
  }
  if (vaultState.config.paused) {
    throw new Error("Vault is paused.");
  }

  const [boringVault] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("boring-vault"),
      vaultIdBuffer,
      Buffer.from([vaultState.config.depositSubAccount]),
    ],
    vaultProgram.programId
  );
  const [assetData] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("asset-data"),
      boringVaultState.toBuffer(),
      spyxMint.toBuffer(),
    ],
    vaultProgram.programId
  );

  const assetDataAccount = await (vaultProgram.account as any).assetData.fetch(
    assetData
  );
  if (!assetDataAccount.allowDeposits) {
    throw new Error("SPYx deposits are not enabled for this vault.");
  }

  const shareMint = vaultState.config.shareMint as PublicKey;
  const userSpyxAta = getAssociatedTokenAddressSync(
    spyxMint,
    payer.publicKey,
    false,
    spyxTokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const vaultSpyxAta = getAssociatedTokenAddressSync(
    spyxMint,
    boringVault,
    true,
    spyxTokenProgramId,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const userShareAta = getAssociatedTokenAddressSync(
    shareMint,
    payer.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const userSpyxAmount = await fetchTokenAmount({
    connection,
    account: userSpyxAta,
    tokenProgramId: spyxTokenProgramId,
  });
  if (userSpyxAmount === undefined) {
    throw new Error(`User SPYx ATA does not exist: ${userSpyxAta.toBase58()}`);
  }
  if (userSpyxAmount === 0n) {
    throw new Error(
      `User SPYx ATA has zero balance: ${userSpyxAta.toBase58()}`
    );
  }

  const rawAmount = process.env.SPYX_DEPOSIT_RAW_AMOUNT
    ? BigInt(process.env.SPYX_DEPOSIT_RAW_AMOUNT)
    : userSpyxAmount;
  if (rawAmount <= 0n) {
    throw new Error(`Invalid deposit amount: ${rawAmount.toString()}`);
  }
  if (rawAmount > userSpyxAmount) {
    throw new Error(
      `Deposit amount ${rawAmount.toString()} exceeds SPYx balance ${userSpyxAmount.toString()}`
    );
  }
  if (rawAmount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Deposit amount is too large for this script.");
  }

  const createVaultAtaIx = (await connection.getAccountInfo(
    vaultSpyxAta,
    "confirmed"
  ))
    ? undefined
    : createAssociatedTokenAccountInstruction(
        payer.publicKey,
        vaultSpyxAta,
        boringVault,
        spyxMint,
        spyxTokenProgramId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      );

  const depositRawAmount = new anchor.BN(rawAmount.toString());
  const depositIx = await (vaultProgram.methods as any)
    .deposit({
      vaultId,
      depositAmount: depositRawAmount,
      minMintAmount: depositRawAmount,
    })
    .accounts({
      signer: payer.publicKey,
      boringVaultState,
      boringVault,
      depositMint: spyxMint,
      assetData,
      userAta: userSpyxAta,
      vaultAta: vaultSpyxAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      tokenProgram2022: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      shareMint,
      userShares: userShareAta,
      priceFeed: PublicKey.default,
    } as any)
    .instruction();

  const artifactName = `spyx-deposit-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}${execute ? "" : "-dry-run"}.json`;
  const artifactPath = path.resolve(
    process.env.DEPLOYMENT_OUT_DIR ||
      path.resolve(__dirname, "..", "deployments"),
    artifactName
  );
  const artifact: DepositArtifact = {
    createdAt: new Date().toISOString(),
    executed: execute,
    rpcUrl: redactRpcUrl(rpcUrl),
    payer: payer.publicKey.toBase58(),
    vaultProgram: vaultProgram.programId.toBase58(),
    spyxMint: spyxMint.toBase58(),
    spyxTokenProgram: spyxTokenProgramId.toBase58(),
    spyxDecimals: spyxMintInfo.decimals,
    vaultId: vaultId.toString(),
    vaultState: boringVaultState.toBase58(),
    boringVault: boringVault.toBase58(),
    shareMint: shareMint.toBase58(),
    userSpyxAta: userSpyxAta.toBase58(),
    vaultSpyxAta: vaultSpyxAta.toBase58(),
    userShareAta: userShareAta.toBase58(),
    depositRawAmount: rawAmount.toString(),
    depositUiAmount: formatTokenAmount(rawAmount, spyxMintInfo.decimals),
    createdVaultAta: Boolean(createVaultAtaIx),
  };
  writeArtifact(artifactPath, artifact);

  console.log("SPYx deposit preflight:");
  console.log(`  execute: ${execute}`);
  console.log(`  payer/depositor: ${payer.publicKey.toBase58()}`);
  console.log(`  vault state: ${boringVaultState.toBase58()}`);
  console.log(`  boring vault: ${boringVault.toBase58()}`);
  console.log(`  share mint: ${shareMint.toBase58()}`);
  console.log(`  user SPYx ATA: ${userSpyxAta.toBase58()}`);
  console.log(`  vault SPYx ATA: ${vaultSpyxAta.toBase58()}`);
  console.log(`  user share ATA: ${userShareAta.toBase58()}`);
  console.log(
    `  deposit: ${artifact.depositUiAmount} SPYx (${rawAmount.toString()} raw)`
  );
  console.log(`  creates vault SPYx ATA: ${Boolean(createVaultAtaIx)}`);
  console.log(`  artifact: ${artifactPath}`);

  const result = await simulateAndMaybeSend({
    instructions: [createVaultAtaIx, depositIx].filter(
      (ix): ix is TransactionInstruction => Boolean(ix)
    ),
    connection,
    payer,
    execute,
  });
  artifact.signature = result.signature;
  artifact.unitsConsumed = result.unitsConsumed;

  if (execute) {
    artifact.postUserSpyxRawAmount = (
      (await fetchTokenAmount({
        connection,
        account: userSpyxAta,
        tokenProgramId: spyxTokenProgramId,
      })) || 0n
    ).toString();
    artifact.postVaultSpyxRawAmount = (
      (await fetchTokenAmount({
        connection,
        account: vaultSpyxAta,
        tokenProgramId: spyxTokenProgramId,
      })) || 0n
    ).toString();
    artifact.postUserSharesRawAmount = (
      (await fetchTokenAmount({
        connection,
        account: userShareAta,
        tokenProgramId: TOKEN_2022_PROGRAM_ID,
      })) || 0n
    ).toString();
  }
  writeArtifact(artifactPath, artifact);

  console.log("SPYx deposit completed.");
  console.log(`  signature: ${artifact.signature || "(dry run)"}`);
  console.log(`  user SPYx raw balance: ${artifact.postUserSpyxRawAmount}`);
  console.log(`  vault SPYx raw balance: ${artifact.postVaultSpyxRawAmount}`);
  console.log(`  user share raw balance: ${artifact.postUserSharesRawAmount}`);
  console.log(`  artifact: ${artifactPath}`);
}

main().catch((error) => {
  console.error("SPYx deposit failed:", error);
  process.exitCode = 1;
});
