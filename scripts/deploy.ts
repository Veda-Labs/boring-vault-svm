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

    const boringAuthority = new PublicKey(
      "96yLsxEoWdYECTb3ryaWWDf91TndJVQLLz8ckWZDDtkR"
    );

    const [vaultConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      vaultProgram.programId
    );

    const [queueConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      queueProgram.programId
    );

    const [boringVaultState] = PublicKey.findProgramAddressSync(
      [Buffer.from("boring-vault-state"), Buffer.from(new Array(8).fill(0))],
      vaultProgram.programId
    );
    const [shareMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("share-token"), boringVaultState.toBuffer()],
      vaultProgram.programId
    );

    // // Deploy Vault
    // console.log("Deploying Vault...");
    // const vaultDeployArgs = {
    //   authority: boringAuthority,
    //   name: "Test Boring Vault",
    //   symbol: "TBV",
    //   exchangeRateProvider: boringAuthority,
    //   exchangeRate: new anchor.BN("1000000000"), // Example rate
    //   payoutAddress: boringAuthority,
    //   allowedExchangeRateChangeUpperBound: 11000, // 110% in bps
    //   allowedExchangeRateChangeLowerBound: 9000, // 90% in bps
    //   minimumUpdateDelayInSeconds: 60, // 1 min
    //   platformFeeBps: 50, // 0.5%
    //   performanceFeeBps: 1000, // 10%
    //   withdrawAuthority: boringAuthority,
    //   strategist: boringAuthority,
    // };

    // const vaultDeployTx = await vaultProgram.methods
    //   .deploy(vaultDeployArgs)
    //   .accounts({
    //     signer: authority.publicKey,
    //     // @ts-ignore
    //     config: vaultConfig,
    //     boringVaultState: boringVaultState,
    //     shareMint: shareMint,
    //     baseAsset: JITOSOL,
    //     systemProgram: anchor.web3.SystemProgram.programId,
    //     tokenProgram: TOKEN_2022_PROGRAM_ID,
    //   })
    //   .rpc();
    // console.log("Vault deployment successful:", vaultDeployTx);

    const [queueState] = PublicKey.findProgramAddressSync(
      [Buffer.from("boring-queue-state"), Buffer.from(new Array(8).fill(0))],
      queueProgram.programId
    );

    // Deploy Queue
    console.log("Deploying Queue...");
    const queueDeployArgs = {
      authority: boringAuthority,
      boringVaultProgram: vaultProgram.programId,
      vaultId: new anchor.BN(0), // Assuming first vault
      shareMint: shareMint, // Fill in with vault's share mint
      solveAuthority: boringAuthority,
    };

    const queueDeployTx = await queueProgram.methods
      .deploy(queueDeployArgs)
      .accounts({
        signer: authority.publicKey,
        // @ts-ignore
        config: queueConfig,
        queueState: queueState,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();
    console.log("Queue deployment successful:", queueDeployTx);
  } catch (error) {
    console.error("Deployment failed:", error);
    throw error;
  }
}

main();
