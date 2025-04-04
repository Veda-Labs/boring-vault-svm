import { Program } from "@coral-xyz/anchor";
import {
    MINT_SIZE,
    TOKEN_2022_PROGRAM_ID,
    createInitializeMintInstruction,
    getMinimumBalanceForRentExemptMint
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import "dotenv/config";
import { BoringVaultSvm } from "../../target/types/boring_vault_svm";

const anchor = require("@coral-xyz/anchor");
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

// Using a known token like JitoSOL for baseAsset in deployment for simplicity
const JITOSOL = new anchor.web3.PublicKey(
  "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn"
);

// Get vault program instance
const vaultProgram = anchor.workspace.BoringVaultSvm as Program<BoringVaultSvm>;

async function main() {
  try {
    const authority = provider.wallet; // Uses wallet from Anchor.toml (e.g., ~/.config/solana/id.json)
    console.log(`Using authority: ${authority.publicKey.toBase58()}`);

    // --- Initialize Vault Program Config ---
    console.log("Initializing Vault Program Config...");
    const [vaultConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      vaultProgram.programId
    );
    console.log(`Vault Config PDA: ${vaultConfig.toBase58()}`);

    try {
      const initVaultTx = await vaultProgram.methods
        .initialize(authority.publicKey)
        .accounts({
          signer: authority.publicKey,
          // @ts-ignore
          config: vaultConfig,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      console.log("Vault Config initialization successful:", initVaultTx);
    } catch (error) {
      if (error.toString().includes("already in use")) {
        console.log("Vault Config already initialized.");
      } else {
        throw error; // Re-throw unexpected errors
      }
    }

    // --- Create a Base Asset Mint for Testing ---
    console.log("Creating dummy base asset mint...");
    const baseAssetMintKp = Keypair.generate();
    const baseAssetMint = baseAssetMintKp.publicKey;
    console.log(`Base Asset Mint Address: ${baseAssetMint.toBase58()}`);

    const lamports = await getMinimumBalanceForRentExemptMint(provider.connection);

    const createMintIx = SystemProgram.createAccount({
        fromPubkey: authority.publicKey,
        newAccountPubkey: baseAssetMint,
        space: MINT_SIZE,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
    });

    const initializeMintIx = createInitializeMintInstruction(
        baseAssetMint,
        9, // Assuming 9 decimals like JitoSOL
        authority.publicKey, // Mint authority
        null, // Freeze authority (optional)
        TOKEN_2022_PROGRAM_ID
    );

    // Add instructions to a transaction
    const tx = new anchor.web3.Transaction().add(createMintIx, initializeMintIx);

    // Send and confirm transaction
    try {
        const sig = await provider.sendAndConfirm(tx, [baseAssetMintKp]); // Sign with the mint's keypair
        console.log("Base Asset Mint created successfully:", sig);
    } catch (error) {
        if (error.toString().includes("already in use")) {
          // This specific check might fail here as the keypair is random.
          // A more robust check would be getAccountInfo before sending.
          console.log("Skipping mint creation, might already exist from previous run?");
        } else {
          console.error("Base Asset Mint creation failed:", error);
          throw error;
        }
    }

    // --- Deploy Vault Instance (ID 0) ---
    console.log("Deploying Vault Instance...");

    // Fetch the config account to get the current vault_count
    const fetchedConfig = await vaultProgram.account.programConfig.fetch(vaultConfig);
    const vaultId = fetchedConfig.vaultCount; // Use the actual vault count from the config
    console.log(`Targeting Vault ID: ${vaultId.toString()}`);

    const vaultIdBuffer = vaultId.toBuffer("le", 8); // Ensure 8 bytes for vault_id seed

    const [boringVaultState] = PublicKey.findProgramAddressSync(
      [Buffer.from("boring-vault-state"), vaultIdBuffer],
      vaultProgram.programId
    );
    const [shareMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("share-token"), boringVaultState.toBuffer()],
      vaultProgram.programId
    );

    console.log(`Boring Vault State PDA (ID ${vaultId.toString()}): ${boringVaultState.toBase58()}`);
    console.log(`Share Mint PDA: ${shareMint.toBase58()}`);

    // Check if vault state already exists
    const vaultStateInfo = await provider.connection.getAccountInfo(boringVaultState);

    if (vaultStateInfo) {
      console.log(`Vault (ID ${vaultId.toString()}) appears to be already deployed (Account exists).`);
    } else {
      // Vault does not exist, proceed with deployment
      // Define deployment arguments, using the provider wallet as the authority
      const vaultDeployArgs = {
        authority: authority.publicKey, // CORRECT: Use provider wallet
        name: "Test Boring Vault 0",
        symbol: "TBV0",
        exchangeRateProvider: authority.publicKey, // CORRECT: Use provider wallet
        exchangeRate: new anchor.BN("1000000000"), // 1.0 with 9 decimals
        payoutAddress: authority.publicKey, // CORRECT: Use provider wallet
        allowedExchangeRateChangeUpperBound: 12000, // 120% (max allowed)
        allowedExchangeRateChangeLowerBound: 8000,   // 80% (min allowed)
        minimumUpdateDelayInSeconds: 0,          // No delay for testing
        platformFeeBps: 100,                     // 1%
        performanceFeeBps: 1000,                 // 10%
        withdrawAuthority: authority.publicKey,  // CORRECT: Use provider wallet (or Pubkey.default() if desired)
        strategist: authority.publicKey,         // CORRECT: Use provider wallet
      };

      try {
        const vaultDeployTx = await vaultProgram.methods
          .deploy(vaultDeployArgs)
          .accounts({
            signer: authority.publicKey,
            // @ts-ignore - Linter struggles with config PDA typing here
            config: vaultConfig,
            // @ts-ignore - Reverting to camelCase, ignoring potential linter error
            boringVaultState: boringVaultState,
            // @ts-ignore - Reverting to camelCase, ignoring potential linter error
            shareMint: shareMint,
            // @ts-ignore - Reverting to camelCase, ignoring potential linter error
            baseAsset: baseAssetMint, // Use the newly created mint
            // @ts-ignore - Reverting to camelCase, ignoring potential linter error
            systemProgram: anchor.web3.SystemProgram.programId,
            // @ts-ignore - Reverting to camelCase, ignoring potential linter error
            tokenProgram: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
        console.log(`Vault deployment successful (ID ${vaultId.toString()}):`, vaultDeployTx);
      } catch (error) {
        // Note: The 'already in use' check inside the catch might be redundant now,
        // but kept for safety in case of race conditions or other edge cases.
        if (error.toString().includes("already in use")) {
          console.log(`Vault (ID ${vaultId.toString()}) deployment attempt failed, likely already deployed.`);
        } else {
          console.error("Vault deployment failed:", error);
          // Log the full error object for more details if needed
          // console.error(JSON.stringify(error, null, 2));
          throw error; // Re-throw unexpected errors
        }
      }
    }

    console.log("\nSetup script completed.");
    console.log(`Program ID: ${vaultProgram.programId.toBase58()}`);
    console.log(`Vault Config PDA: ${vaultConfig.toBase58()}`);
    console.log(`Authority: ${authority.publicKey.toBase58()}`);
    console.log(`Vault State PDA (ID 0): ${boringVaultState.toBase58()}`);

  } catch (error) {
    console.error("Setup script failed:", error);
    process.exit(1);
  }
}

main(); 