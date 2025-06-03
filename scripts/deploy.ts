import { Program } from "@coral-xyz/anchor";
import { BoringVaultSvm } from "../target/types/boring_vault_svm";
import { BoringOnchainQueue } from "../target/types/boring_onchain_queue";
import { PublicKey, Connection } from "@solana/web3.js";
import "dotenv/config";

const anchor = require("@coral-xyz/anchor");

// Create connection with polling-only (no websockets)
const connection = new Connection(
  process.env.ANCHOR_PROVIDER_URL!,
  {
    commitment: 'confirmed',
    disableRetryOnRateLimit: false,
    confirmTransactionInitialTimeout: 60000, // 60 seconds
  }
);

// Create provider with the polling connection
const provider = new anchor.AnchorProvider(
  connection,
  anchor.AnchorProvider.env().wallet,
  {
    commitment: 'confirmed',
    skipPreflight: false,
  }
);
anchor.setProvider(provider);

// Helper function to poll for transaction confirmation
async function waitForConfirmation(signature: string, connection: Connection): Promise<void> {
  console.log(`Polling for confirmation of transaction: ${signature}`);
  
  for (let i = 0; i < 60; i++) { // Poll for up to 60 seconds
    try {
      const result = await connection.getSignatureStatus(signature);
      if (result?.value?.confirmationStatus === 'confirmed' || result?.value?.confirmationStatus === 'finalized') {
        console.log(`Transaction confirmed after ${i + 1} attempts`);
        return;
      }
      if (result?.value?.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(result.value.err)}`);
      }
    } catch (error) {
      console.log(`Polling attempt ${i + 1} failed, retrying...`);
    }
    
    // Wait 1 second before next poll
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  
  throw new Error(`Transaction confirmation timeout after 60 seconds: ${signature}`);
}

const JITOSOL = new anchor.web3.PublicKey(
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"
);

// Get program instances
const vaultProgram = anchor.workspace.BoringVaultSvm as Program<BoringVaultSvm>;
const queueProgram = anchor.workspace
  .BoringOnchainQueue as Program<BoringOnchainQueue>;

async function main() {
  try {
    const authority = provider.wallet;

    const boringAuthority = new PublicKey(
      "CSsqdfpwwBK8iueo9CuTLHc1M2uubj88UwXKCgZap7H2"
    );

    const [vaultConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      vaultProgram.programId
    );

    const [queueConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      queueProgram.programId
    );

    // Get current vault count to determine next vault ID
    console.log("Fetching current vault count...");
    const configAccount = await vaultProgram.account.programConfig.fetch(vaultConfig);
    const nextVaultId = configAccount.vaultCount;
    console.log(`Next vault ID will be: ${nextVaultId.toString()}`);

    // Generate PDAs for the new vault using the correct vault ID
    const [boringVaultState] = PublicKey.findProgramAddressSync(
      [Buffer.from("boring-vault-state"), nextVaultId.toBuffer("le", 8)],
      vaultProgram.programId
    );
    const [shareMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("share-token"), boringVaultState.toBuffer()],
      vaultProgram.programId
    );

    // Deploy Vault
    console.log("Deploying Vault...");
    const vaultDeployArgs = {
      authority: boringAuthority,
      name: "Boring Vault " + nextVaultId.toString(),
      symbol: "BV" + nextVaultId.toString(),
      exchangeRateProvider: boringAuthority,
      exchangeRate: new anchor.BN("1000000000"),
      payoutAddress: boringAuthority,
      allowedExchangeRateChangeUpperBound: 10100,
      allowedExchangeRateChangeLowerBound: 9900,
      minimumUpdateDelayInSeconds: 3600,
      platformFeeBps: 0,
      performanceFeeBps: 0,
      withdrawAuthority: PublicKey.default,
      strategist: boringAuthority,
    };

    // Build transaction manually using instruction
    const vaultInstruction = await vaultProgram.methods
      .deploy(vaultDeployArgs)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: boringVaultState,
        baseAsset: JITOSOL,
      })
      .instruction();

    // Create transaction and add instruction
    const vaultTransaction = new anchor.web3.Transaction();
    vaultTransaction.add(vaultInstruction);
    
    // Get recent blockhash
    const { blockhash } = await connection.getLatestBlockhash();
    vaultTransaction.recentBlockhash = blockhash;
    vaultTransaction.feePayer = authority.publicKey;
    
    // Sign and send transaction
    vaultTransaction.sign(provider.wallet.payer);
    const vaultTxSignature = await connection.sendRawTransaction(vaultTransaction.serialize(), {
      skipPreflight: false,
    });

    console.log("✅ Vault deployment transaction sent!");
    console.log(`📊 Vault ID: ${nextVaultId.toString()}`);
    console.log(`🏦 Base Asset: ${JITOSOL.toString()} (jitoSOL)`);
    console.log(`🔗 Transaction: ${vaultTxSignature}`);
    
    // Poll for confirmation without websockets
    console.log("Polling for vault deployment confirmation...");
    await waitForConfirmation(vaultTxSignature, connection);
    console.log("Vault deployment confirmed!");

    const [queueState] = PublicKey.findProgramAddressSync(
      [Buffer.from("boring-queue-state"), nextVaultId.toBuffer("le", 8)],
      queueProgram.programId
    );

    // Deploy Queue
    console.log("Deploying Queue...");
    const queueDeployArgs = {
      authority: boringAuthority,
      boringVaultProgram: vaultProgram.programId,
      vaultId: nextVaultId, // Use the actual vault ID instead of hardcoded 5
      shareMint: shareMint, // Fill in with vault's share mint
      solveAuthority: boringAuthority,
    };

    // Build queue transaction manually using instruction
    const queueInstruction = await queueProgram.methods
      .deploy(queueDeployArgs)
      .accounts({
        signer: authority.publicKey,
        queueState: queueState,
      })
      .instruction();

    // Create transaction and add instruction
    const queueTransaction = new anchor.web3.Transaction();
    queueTransaction.add(queueInstruction);
    
    // Get recent blockhash
    const { blockhash: queueBlockhash } = await connection.getLatestBlockhash();
    queueTransaction.recentBlockhash = queueBlockhash;
    queueTransaction.feePayer = authority.publicKey;
    
    // Sign and send transaction
    queueTransaction.sign(provider.wallet.payer);
    const queueTxSignature = await connection.sendRawTransaction(queueTransaction.serialize(), {
      skipPreflight: false,
    });
    
    console.log("✅ Queue deployment transaction sent!");
    console.log(`🔗 Queue Transaction: ${queueTxSignature}`);
    
    // Poll for confirmation without websockets
    console.log("Polling for queue deployment confirmation...");
    await waitForConfirmation(queueTxSignature, connection);
    console.log("Queue deployment confirmed!");
    
    console.log("\n🎉 All deployments completed successfully!");
  } catch (error) {
    console.error("Deployment failed:", error);
    throw error;
  }
}

main();
