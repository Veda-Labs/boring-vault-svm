import { Program } from "@coral-xyz/anchor";
import { BoringVaultSvm } from "../target/types/boring_vault_svm";
import { BoringOnchainQueue } from "../target/types/boring_onchain_queue";
import { PublicKey } from "@solana/web3.js";
import "dotenv/config";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

const anchor = require("@coral-xyz/anchor");
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);

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

    // const boringAuthority = new PublicKey(
    //   "96yLsxEoWdYECTb3ryaWWDf91TndJVQLLz8ckWZDDtkR"
    // );

    // // Initialize Vault Program
    // console.log("Initializing Vault Program...");
    // const [vaultConfig] = PublicKey.findProgramAddressSync(
    //   [Buffer.from("config")],
    //   vaultProgram.programId
    // );

    // console.log("Vault Config PDA:", vaultConfig.toString());

    // const initVaultTx = await vaultProgram.methods
    //   .initialize(authority.publicKey)
    //   .accounts({
    //     signer: authority.publicKey,
    //     // @ts-ignore
    //     config: vaultConfig,
    //     systemProgram: anchor.web3.SystemProgram.programId,
    //   })
    //   .rpc();
    // console.log("Vault initialization successful:", initVaultTx);

    // Initialize Queue Program
    console.log("Initializing Queue Program...");
    const [queueConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      queueProgram.programId
    );

    const initQueueTx = await queueProgram.methods
      .initialize(authority.publicKey)
      .accounts({
        signer: authority.publicKey,
        // @ts-ignore
        config: queueConfig,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("Queue initialization successful:", initQueueTx);
  } catch (error) {
    console.error("Deployment failed:", error);
    throw error;
  }
}

main();
