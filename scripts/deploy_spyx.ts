import { Program } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
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

const FALLBACK_VAULT_PROGRAM_ID =
  "5ZRnXG4GsUMLaN7w2DtJV1cgLgcXHmuHCmJ2MxoorWCE";
const FALLBACK_QUEUE_PROGRAM_ID =
  "4yfE2VJQmxmcnUhrb8vdz7H8w313EZ3eJh5DbANBgtmd";
const DEFAULT_SPYX_MINT = "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W";

const SHARE_NAME = "Boring SPYx Vault";
const SHARE_SYMBOL = "bvSPYx";

const VAULT_EXCHANGE_RATE_UPPER_BOUND = 10100;
const VAULT_EXCHANGE_RATE_LOWER_BOUND = 9900;
const VAULT_MIN_UPDATE_DELAY_SECONDS = 3600;
const QUEUE_SECONDS_TO_MATURITY = 60;
const QUEUE_MIN_SECONDS_TO_DEADLINE = 2_592_000;
const QUEUE_MIN_DISCOUNT_BPS = 0;
const QUEUE_MAX_DISCOUNT_BPS = 100;
const QUEUE_MIN_SHARES = new anchor.BN(1);

type TxRecord = {
  simulated: boolean;
  signature?: string;
  confirmed?: boolean;
  unitsConsumed?: number;
};

type DeploymentArtifact = {
  createdAt: string;
  executed: boolean;
  rpcUrl: string;
  payer: string;
  vaultProgram: string;
  queueProgram: string;
  spyxMint: string;
  spyxTokenProgram?: string;
  spyxDecimals?: number;
  exchangeRate?: string;
  vaultId?: string;
  vaultState?: string;
  shareMint?: string;
  assetData?: string;
  queueState?: string;
  queueWithdrawAssetData?: string;
  transactions: Record<string, TxRecord>;
};

function envBool(name: string, defaultValue = false): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

function readIdlProgramId(idlName: string): PublicKey | undefined {
  const file = path.resolve(
    __dirname,
    "..",
    "target",
    "idl",
    `${idlName}.json`
  );
  if (!fs.existsSync(file)) return undefined;
  const idl = JSON.parse(fs.readFileSync(file, "utf8"));
  const address = idl.address || idl.metadata?.address;
  return address ? new PublicKey(address) : undefined;
}

function envPublicKey(name: string, fallback: string): PublicKey {
  return new PublicKey(process.env[name] || fallback);
}

function envProgramId(
  name: string,
  idlName: string,
  fallback: string
): PublicKey {
  const value = process.env[name];
  if (value) return new PublicKey(value);
  return readIdlProgramId(idlName) || new PublicKey(fallback);
}

function vaultIdToBuffer(vaultId: anchor.BN): Buffer {
  return vaultId.toArrayLike(Buffer, "le", 8);
}

function bnToString(value: anchor.BN | number | bigint): string {
  if (anchor.BN.isBN(value)) return value.toString();
  return value.toString();
}

function assertPublicKeyEquals(
  label: string,
  actual: PublicKey,
  expected: PublicKey
) {
  if (!actual.equals(expected)) {
    throw new Error(
      `${label} mismatch: expected ${expected.toBase58()}, got ${actual.toBase58()}`
    );
  }
}

function assertNumberEquals(label: string, actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error(`${label} mismatch: expected ${expected}, got ${actual}`);
  }
}

function assertBnEquals(label: string, actual: anchor.BN, expected: anchor.BN) {
  if (!actual.eq(expected)) {
    throw new Error(
      `${label} mismatch: expected ${expected.toString()}, got ${actual.toString()}`
    );
  }
}

function writeArtifact(artifactPath: string, artifact: DeploymentArtifact) {
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
  execute: boolean;
  artifact: DeploymentArtifact;
  artifactPath: string;
}): Promise<string | undefined> {
  const {
    label,
    instruction,
    connection,
    payer,
    execute,
    artifact,
    artifactPath,
  } = args;
  const tx = new Transaction().add(instruction);
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer);

  console.log(`Simulating ${label}...`);
  const simulation = await connection.simulateTransaction(tx);
  artifact.transactions[label] = {
    simulated: true,
    unitsConsumed: simulation.value.unitsConsumed || undefined,
  };
  writeArtifact(artifactPath, artifact);

  if (simulation.value.err) {
    console.error(simulation.value.logs?.join("\n"));
    throw new Error(
      `${label} simulation failed: ${JSON.stringify(simulation.value.err)}`
    );
  }

  if (!execute) {
    console.log(`Simulation passed for ${label}.`);
    return undefined;
  }

  console.log(`Sending ${label}...`);
  const signature = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
  });
  artifact.transactions[label].signature = signature;
  writeArtifact(artifactPath, artifact);

  await waitForConfirmation(signature, connection);
  artifact.transactions[label].confirmed = true;
  writeArtifact(artifactPath, artifact);
  console.log(`${label} confirmed: ${signature}`);
  return signature;
}

async function fetchMintInfo(connection: Connection, mint: PublicKey) {
  const accountInfo = await connection.getAccountInfo(mint, "confirmed");
  if (!accountInfo) {
    throw new Error(`Mint account not found: ${mint.toBase58()}`);
  }
  const tokenProgramId = accountInfo.owner;
  if (
    !tokenProgramId.equals(TOKEN_PROGRAM_ID) &&
    !tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    throw new Error(
      `Mint ${mint.toBase58()} is owned by ${tokenProgramId.toBase58()}, not an SPL token program`
    );
  }

  const mintInfo = await getMint(connection, mint, "confirmed", tokenProgramId);
  if (!mintInfo.isInitialized) {
    throw new Error(`Mint ${mint.toBase58()} is not initialized`);
  }
  return { mintInfo, tokenProgramId };
}

async function maybeAssertShareMetadata(
  connection: Connection,
  shareMint: PublicKey
) {
  let getTokenMetadata: any;
  try {
    const splToken = require("@solana/spl-token");
    if (typeof splToken.getTokenMetadata !== "function") {
      console.warn(
        "Skipping share metadata assertion; getTokenMetadata is unavailable."
      );
      return;
    }
    getTokenMetadata = splToken.getTokenMetadata;
  } catch (error) {
    console.warn(
      `Share metadata assertion skipped: ${(error as Error).message}`
    );
    return;
  }

  const metadata = await getTokenMetadata(
    connection,
    shareMint,
    "confirmed",
    TOKEN_2022_PROGRAM_ID
  );
  if (!metadata) {
    console.warn("Skipping share metadata assertion; no metadata returned.");
    return;
  }
  if (metadata.name !== SHARE_NAME || metadata.symbol !== SHARE_SYMBOL) {
    throw new Error(
      `Share metadata mismatch: expected ${SHARE_NAME}/${SHARE_SYMBOL}, got ${metadata.name}/${metadata.symbol}`
    );
  }
  console.log(`Verified share metadata: ${metadata.name} (${metadata.symbol})`);
}

async function main() {
  const execute = envBool("EXECUTE", false);
  const rpcUrl =
    process.env.SPYX_RPC_URL ||
    process.env.ANCHOR_PROVIDER_URL ||
    process.env.SOLANA_RPC_URL ||
    DEFAULT_RPC_URL;
  const walletPath = process.env.ANCHOR_WALLET;
  if (!walletPath) {
    throw new Error("ANCHOR_WALLET must point to the authority keypair JSON.");
  }

  const vaultProgramId = envProgramId(
    "BORING_VAULT_PROGRAM_ID",
    "boring_vault_svm",
    FALLBACK_VAULT_PROGRAM_ID
  );
  const queueProgramId = envProgramId(
    "BORING_QUEUE_PROGRAM_ID",
    "boring_onchain_queue",
    FALLBACK_QUEUE_PROGRAM_ID
  );
  const spyxMint = envPublicKey("SPYX_MINT", DEFAULT_SPYX_MINT);

  if (execute && !envBool("CONFIRM_SPYX_MINT", false)) {
    throw new Error(
      "Set CONFIRM_SPYX_MINT=true after verifying SPYx against Backed/CoinGecko/Solscan."
    );
  }
  if (
    execute &&
    !spyxMint.equals(new PublicKey(DEFAULT_SPYX_MINT)) &&
    !envBool("ALLOW_CUSTOM_SPYX_MINT", false)
  ) {
    throw new Error(
      "Custom SPYX_MINT requires ALLOW_CUSTOM_SPYX_MINT=true for live execution."
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

  const artifactName = `spyx-vault-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}${execute ? "" : "-dry-run"}.json`;
  const artifactPath = path.resolve(
    process.env.DEPLOYMENT_OUT_DIR ||
      path.resolve(__dirname, "..", "deployments"),
    artifactName
  );
  const artifact: DeploymentArtifact = {
    createdAt: new Date().toISOString(),
    executed: execute,
    rpcUrl: redactRpcUrl(rpcUrl),
    payer: payer.publicKey.toBase58(),
    vaultProgram: vaultProgram.programId.toBase58(),
    queueProgram: queueProgram.programId.toBase58(),
    spyxMint: spyxMint.toBase58(),
    transactions: {},
  };

  const vaultProgramInfo = await connection.getAccountInfo(
    vaultProgram.programId
  );
  const queueProgramInfo = await connection.getAccountInfo(
    queueProgram.programId
  );
  if (!vaultProgramInfo?.executable) {
    throw new Error(
      `Vault program is not executable: ${vaultProgram.programId.toBase58()}`
    );
  }
  if (!queueProgramInfo?.executable) {
    throw new Error(
      `Queue program is not executable: ${queueProgram.programId.toBase58()}`
    );
  }

  const { mintInfo: spyxMintInfo, tokenProgramId: spyxTokenProgramId } =
    await fetchMintInfo(connection, spyxMint);
  const exchangeRateValue = 10n ** BigInt(spyxMintInfo.decimals);
  if (exchangeRateValue > 18_446_744_073_709_551_615n) {
    throw new Error(
      `Derived exchange rate does not fit u64: ${exchangeRateValue}`
    );
  }
  const exchangeRate = new anchor.BN(exchangeRateValue.toString());
  artifact.spyxTokenProgram = spyxTokenProgramId.toBase58();
  artifact.spyxDecimals = spyxMintInfo.decimals;
  artifact.exchangeRate = exchangeRate.toString();

  const [vaultConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    vaultProgram.programId
  );
  const [queueConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    queueProgram.programId
  );

  const vaultConfigAccount = await (
    vaultProgram.account as any
  ).programConfig.fetch(vaultConfig);
  const queueConfigAccount = await (
    queueProgram.account as any
  ).programConfig.fetch(queueConfig);
  assertPublicKeyEquals(
    "vault config authority",
    vaultConfigAccount.authority,
    payer.publicKey
  );
  assertPublicKeyEquals(
    "queue config authority",
    queueConfigAccount.authority,
    payer.publicKey
  );

  const vaultId = vaultConfigAccount.vaultCount as anchor.BN;
  const vaultIdBuffer = vaultIdToBuffer(vaultId);
  const [boringVaultState] = PublicKey.findProgramAddressSync(
    [Buffer.from("boring-vault-state"), vaultIdBuffer],
    vaultProgram.programId
  );
  const [shareMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("share-token"), boringVaultState.toBuffer()],
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
  const [queueState] = PublicKey.findProgramAddressSync(
    [Buffer.from("boring-queue-state"), vaultIdBuffer],
    queueProgram.programId
  );
  const [queueWithdrawAssetData] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("boring-queue-withdraw-asset-data"),
      vaultIdBuffer,
      spyxMint.toBuffer(),
    ],
    queueProgram.programId
  );

  artifact.vaultId = vaultId.toString();
  artifact.vaultState = boringVaultState.toBase58();
  artifact.shareMint = shareMint.toBase58();
  artifact.assetData = assetData.toBase58();
  artifact.queueState = queueState.toBase58();
  artifact.queueWithdrawAssetData = queueWithdrawAssetData.toBase58();
  writeArtifact(artifactPath, artifact);

  console.log("SPYx vault deployment preflight:");
  console.log(`  execute: ${execute}`);
  console.log(`  payer/authority: ${payer.publicKey.toBase58()}`);
  console.log(`  SPYx mint: ${spyxMint.toBase58()}`);
  console.log(`  SPYx token program: ${spyxTokenProgramId.toBase58()}`);
  console.log(`  SPYx decimals: ${spyxMintInfo.decimals}`);
  console.log(`  initial exchange rate: ${exchangeRate.toString()}`);
  console.log(`  vault id: ${vaultId.toString()}`);
  console.log(`  vault state: ${boringVaultState.toBase58()}`);
  console.log(`  share mint: ${shareMint.toBase58()}`);
  console.log(`  queue state: ${queueState.toBase58()}`);
  console.log(`  artifact: ${artifactPath}`);

  const vaultDeployArgs = {
    authority: payer.publicKey,
    name: SHARE_NAME,
    symbol: SHARE_SYMBOL,
    exchangeRateProvider: payer.publicKey,
    exchangeRate,
    payoutAddress: payer.publicKey,
    allowedExchangeRateChangeUpperBound: VAULT_EXCHANGE_RATE_UPPER_BOUND,
    allowedExchangeRateChangeLowerBound: VAULT_EXCHANGE_RATE_LOWER_BOUND,
    minimumUpdateDelayInSeconds: VAULT_MIN_UPDATE_DELAY_SECONDS,
    platformFeeBps: 0,
    performanceFeeBps: 0,
    withdrawAuthority: PublicKey.default,
    strategist: payer.publicKey,
  };
  const vaultDeployIx = await (vaultProgram.methods as any)
    .deploy(vaultDeployArgs)
    .accounts({
      signer: payer.publicKey,
      config: vaultConfig,
      boringVaultState,
      shareMint,
      baseAsset: spyxMint,
      systemProgram: SystemProgram.programId,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    } as any)
    .instruction();

  await simulateAndMaybeSend({
    label: "deployVault",
    instruction: vaultDeployIx,
    connection,
    payer,
    execute,
    artifact,
    artifactPath,
  });

  if (!execute) {
    console.log(
      "Dry run stopped after vault deployment simulation. Set EXECUTE=true and CONFIRM_SPYX_MINT=true to send and continue dependent steps."
    );
    return;
  }

  const vaultStateAfterDeploy = await (
    vaultProgram.account as any
  ).boringVault.fetch(boringVaultState);
  assertPublicKeyEquals(
    "vault base asset",
    vaultStateAfterDeploy.teller.baseAsset,
    spyxMint
  );
  assertPublicKeyEquals(
    "vault share mint",
    vaultStateAfterDeploy.config.shareMint,
    shareMint
  );
  assertPublicKeyEquals(
    "vault authority",
    vaultStateAfterDeploy.config.authority,
    payer.publicKey
  );
  assertPublicKeyEquals(
    "exchange rate provider",
    vaultStateAfterDeploy.teller.exchangeRateProvider,
    payer.publicKey
  );
  assertPublicKeyEquals(
    "payout address",
    vaultStateAfterDeploy.teller.payoutAddress,
    payer.publicKey
  );
  assertPublicKeyEquals(
    "strategist",
    vaultStateAfterDeploy.manager.strategist,
    payer.publicKey
  );
  assertPublicKeyEquals(
    "withdraw authority",
    vaultStateAfterDeploy.teller.withdrawAuthority,
    PublicKey.default
  );
  assertBnEquals(
    "exchange rate",
    vaultStateAfterDeploy.teller.exchangeRate,
    exchangeRate
  );
  assertNumberEquals(
    "platform fee bps",
    vaultStateAfterDeploy.teller.platformFeeBps,
    0
  );
  assertNumberEquals(
    "performance fee bps",
    vaultStateAfterDeploy.teller.performanceFeeBps,
    0
  );

  const { mintInfo: shareMintInfo } = await fetchMintInfo(
    connection,
    shareMint
  );
  assertNumberEquals(
    "share mint decimals",
    shareMintInfo.decimals,
    spyxMintInfo.decimals
  );
  await maybeAssertShareMetadata(connection, shareMint);

  const queueDeployArgs = {
    authority: payer.publicKey,
    boringVaultProgram: vaultProgram.programId,
    vaultId,
    shareMint,
    solveAuthority: payer.publicKey,
  };
  const queueDeployIx = await (queueProgram.methods as any)
    .deploy(queueDeployArgs)
    .accounts({
      signer: payer.publicKey,
      config: queueConfig,
      queueState,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
  await simulateAndMaybeSend({
    label: "deployQueue",
    instruction: queueDeployIx,
    connection,
    payer,
    execute,
    artifact,
    artifactPath,
  });

  const queueStateAfterDeploy = await (
    queueProgram.account as any
  ).queueState.fetch(queueState);
  assertPublicKeyEquals(
    "queue authority",
    queueStateAfterDeploy.authority,
    payer.publicKey
  );
  assertPublicKeyEquals(
    "queue boring vault program",
    queueStateAfterDeploy.boringVaultProgram,
    vaultProgram.programId
  );
  assertBnEquals("queue vault id", queueStateAfterDeploy.vaultId, vaultId);
  assertPublicKeyEquals(
    "queue share mint",
    queueStateAfterDeploy.shareMint,
    shareMint
  );
  assertPublicKeyEquals(
    "queue solve authority",
    queueStateAfterDeploy.solveAuthority,
    payer.publicKey
  );

  const assetDataArgs = {
    vaultId,
    assetData: {
      allowDeposits: true,
      allowWithdrawals: true,
      sharePremiumBps: 0,
      isPeggedToBaseAsset: true,
      inversePriceFeed: false,
      maxStaleness: new anchor.BN(0),
      oracleSource: {
        pythV2: {
          feedId: Array(32).fill(0),
          maxConfWidthBps: 500,
        },
      },
    },
  };
  const updateAssetDataIx = await (vaultProgram.methods as any)
    .updateAssetData(assetDataArgs)
    .accounts({
      signer: payer.publicKey,
      boringVaultState,
      systemProgram: SystemProgram.programId,
      asset: spyxMint,
      assetData,
    } as any)
    .instruction();
  await simulateAndMaybeSend({
    label: "configureSpyxAssetData",
    instruction: updateAssetDataIx,
    connection,
    payer,
    execute,
    artifact,
    artifactPath,
  });

  const assetDataAfterUpdate = await (
    vaultProgram.account as any
  ).assetData.fetch(assetData);
  if (
    !assetDataAfterUpdate.allowDeposits ||
    !assetDataAfterUpdate.allowWithdrawals
  ) {
    throw new Error("SPYx asset data did not enable deposits and withdrawals.");
  }
  assertNumberEquals(
    "SPYx share premium bps",
    assetDataAfterUpdate.sharePremiumBps,
    0
  );
  if (!assetDataAfterUpdate.isPeggedToBaseAsset) {
    throw new Error("SPYx asset data is not pegged to base asset.");
  }

  const queueWithdrawArgs = {
    vaultId,
    allowWithdraws: true,
    secondsToMaturity: QUEUE_SECONDS_TO_MATURITY,
    minimumSecondsToDeadline: QUEUE_MIN_SECONDS_TO_DEADLINE,
    minimumDiscount: QUEUE_MIN_DISCOUNT_BPS,
    maximumDiscount: QUEUE_MAX_DISCOUNT_BPS,
    minimumShares: QUEUE_MIN_SHARES,
  };
  const updateQueueWithdrawIx = await (queueProgram.methods as any)
    .updateWithdrawAssetData(queueWithdrawArgs)
    .accounts({
      signer: payer.publicKey,
      queueState,
      withdrawMint: spyxMint,
      withdrawAssetData: queueWithdrawAssetData,
      systemProgram: SystemProgram.programId,
    } as any)
    .instruction();
  await simulateAndMaybeSend({
    label: "configureSpyxQueueWithdrawals",
    instruction: updateQueueWithdrawIx,
    connection,
    payer,
    execute,
    artifact,
    artifactPath,
  });

  const withdrawAssetData = await (
    queueProgram.account as any
  ).withdrawAssetData.fetch(queueWithdrawAssetData);
  if (!withdrawAssetData.allowWithdrawals) {
    throw new Error("Queue SPYx withdrawals are not enabled.");
  }
  assertNumberEquals(
    "queue seconds to maturity",
    withdrawAssetData.secondsToMaturity,
    QUEUE_SECONDS_TO_MATURITY
  );
  assertNumberEquals(
    "queue minimum seconds to deadline",
    withdrawAssetData.minimumSecondsToDeadline,
    QUEUE_MIN_SECONDS_TO_DEADLINE
  );
  assertNumberEquals(
    "queue minimum discount",
    withdrawAssetData.minimumDiscount,
    QUEUE_MIN_DISCOUNT_BPS
  );
  assertNumberEquals(
    "queue maximum discount",
    withdrawAssetData.maximumDiscount,
    QUEUE_MAX_DISCOUNT_BPS
  );
  assertBnEquals(
    "queue minimum shares",
    withdrawAssetData.minimumShares,
    QUEUE_MIN_SHARES
  );

  writeArtifact(artifactPath, artifact);
  console.log("SPYx vault deployment completed.");
  console.log(`  vault id: ${bnToString(vaultId)}`);
  console.log(`  vault state: ${boringVaultState.toBase58()}`);
  console.log(`  share mint: ${shareMint.toBase58()}`);
  console.log(`  queue state: ${queueState.toBase58()}`);
  console.log(`  artifact: ${artifactPath}`);
}

main().catch((error) => {
  console.error("SPYx deployment failed:", error);
  process.exitCode = 1;
});
