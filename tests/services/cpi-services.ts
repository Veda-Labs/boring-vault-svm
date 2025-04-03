import { PublicKey, AccountMeta, Keypair } from "@solana/web3.js";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { BoringVaultSvm } from "../../target/types/boring_vault_svm";
import { BanksClient, BanksTransactionResultWithMeta } from "solana-bankrun";
import { TestHelperService as ths } from "./";

export class CpiService {
  static getJitoSolDepositAccounts(params: {
    stakePool: PublicKey;
    withdrawAuth: PublicKey;
    reserve: PublicKey;
    vault: PublicKey;
    vaultAta: PublicKey;
    fee: PublicKey;
    jitoSol: PublicKey;
    systemProgram: PublicKey;
    tokenProgram: PublicKey;
    stakePoolProgram: PublicKey;
  }): AccountMeta[] {
    return [
      { pubkey: params.stakePool, isWritable: true, isSigner: false },
      { pubkey: params.withdrawAuth, isWritable: false, isSigner: false },
      { pubkey: params.reserve, isWritable: true, isSigner: false },
      { pubkey: params.vault, isWritable: true, isSigner: false },
      { pubkey: params.vaultAta, isWritable: true, isSigner: false },
      { pubkey: params.fee, isWritable: true, isSigner: false },
      { pubkey: params.vaultAta, isWritable: true, isSigner: false },
      { pubkey: params.jitoSol, isWritable: true, isSigner: false },
      { pubkey: params.systemProgram, isWritable: false, isSigner: false },
      { pubkey: params.tokenProgram, isWritable: false, isSigner: false },
      { pubkey: params.stakePoolProgram, isWritable: false, isSigner: false },
    ];
  }

  static getJitoSolDepositOperators() {
    return {
      operators: [
        { ingestInstruction: { 0: 0, 1: 1 } },
        { ingestAccount: 0 },
        { ingestAccount: 1 },
        { ingestAccount: 2 },
        { ingestAccount: 3 },
        { ingestAccount: 4 },
        { ingestAccount: 5 },
        { ingestAccount: 6 },
        { ingestAccount: 7 },
        { ingestAccount: 8 },
        { ingestAccount: 9 },
      ],
    };
  }

  static getCreateAccountWithSeedOperators() {
    return {
      operators: [
        { ingestInstruction: { 0: 0, 1: 4 } },
        { ingestInstruction: { 0: 92, 1: 32 } },
        { ingestAccount: 0 },
      ],
    };
  }

  static getInitObligationOperators() {
    return {
      operators: [{ ingestInstruction: { 0: 0, 1: 1 } }, { ingestAccount: 2 }],
    };
  }

  static getDepositOperators() {
    return {
      operators: [
        { ingestAccount: 0 },
        { ingestAccount: 1 },
        { ingestAccount: 2 },
        { ingestAccount: 3 },
        { ingestAccount: 4 },
        { ingestAccount: 5 },
        { ingestAccount: 6 },
        { ingestAccount: 7 },
        { ingestAccount: 9 },
        { ingestAccount: 10 },
        { ingestAccount: 11 },
        { ingestAccount: 12 },
      ],
    };
  }

  static getWSolTransferOperators() {
    return {
      operators: [{ ingestAccount: 0 }, { ingestAccount: 1 }],
    };
  }

  static getWSolWrapOperators() {
    return {
      operators: [{ ingestInstruction: { 0: 0, 1: 1 } }, { ingestAccount: 0 }],
    };
  }

  static getCreateLookupTableOperators() {
    return {
      operators: [],
    };
  }

  //   TODO
  static getInitUserMetadataOperators() {
    return {
      operators: [],
    };
  }

  static createTransferIxData(amount: number): Buffer {
    const buffer = Buffer.alloc(12); // 4 bytes discriminator + 8 bytes for u64
    buffer.write("0200000000", "hex"); // Transfer instruction discriminator (4 bytes)
    buffer.writeBigUInt64LE(BigInt(amount), 4); // Write amount after 4-byte discriminator
    return buffer;
  }

  static async executeCpi(
    params: {
      program: Program<BoringVaultSvm>;
      client: BanksClient;
      deployer: Keypair;
      authority: Keypair;
      strategist: Keypair;
      vaultId: anchor.BN;
      ixProgramId: PublicKey;
      ixData: Buffer;
      operators: any[];
      expectedSize: number;
      accounts: {
        boringVaultState: PublicKey;
        boringVault: PublicKey;
      };
    },
    remainingAccounts: AccountMeta[]
  ): Promise<BanksTransactionResultWithMeta> {
    // 1. View CPI Digest
    const digest = await params.program.methods
      .viewCpiDigest(
        // @ts-ignore
        {
          ixProgramId: params.ixProgramId,
          ixData: params.ixData,
          operators: params.operators,
          expectedSize: params.expectedSize,
        }
      )
      .signers([params.deployer])
      .remainingAccounts(remainingAccounts)
      .view();

    // 2. Find CPI Digest Account
    const [cpiDigestAccount] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("cpi-digest"),
        Buffer.from(new Array(8).fill(0)),
        Buffer.from(digest),
      ],
      params.program.programId
    );

    // 3. Initialize CPI Digest
    const initializeIx = await params.program.methods
      .initializeCpiDigest(
        // @ts-ignore
        {
          vaultId: params.vaultId,
          cpiDigest: digest,
          operators: params.operators,
          expectedSize: params.expectedSize,
        }
      )
      .accounts({
        signer: params.authority.publicKey,
        boringVaultState: params.accounts.boringVaultState,
        // @ts-ignore
        systemProgram: anchor.web3.SystemProgram.programId,
        cpiDigest: cpiDigestAccount,
      })
      .instruction();

    const initializeTxResult = await ths.createAndProcessTransaction(
      params.client,
      params.deployer,
      initializeIx,
      [params.authority]
    );

    if (initializeTxResult.result !== null) {
      throw new Error("Failed to initialize CPI digest");
    }

    // 4. Execute Manage
    const manageIx = await params.program.methods
      .manage(
        // @ts-ignore
        {
          vaultId: params.vaultId,
          subAccount: 0,
          ixProgramId: params.ixProgramId,
          ixData: params.ixData,
        }
      )
      .accounts({
        signer: params.strategist.publicKey,
        boringVaultState: params.accounts.boringVaultState,
        boringVault: params.accounts.boringVault,
        cpiDigest: cpiDigestAccount,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();

    const manageTxResult = await ths.createAndProcessTransaction(
      params.client,
      params.deployer,
      manageIx,
      [params.strategist]
    );

    // 5. Close CPI Digest
    const closeIx = await params.program.methods
      .closeCpiDigest(
        // @ts-ignore
        {
          vaultId: params.vaultId,
          cpiDigest: digest,
          operators: params.operators,
          expectedSize: params.expectedSize,
        }
      )
      .accounts({
        signer: params.authority.publicKey,
        boringVaultState: params.accounts.boringVaultState,
        cpiDigest: cpiDigestAccount,
      })
      .instruction();

    const closeTxResult = await ths.createAndProcessTransaction(
      params.client,
      params.deployer,
      closeIx,
      [params.authority]
    );

    if (closeTxResult.result !== null) {
      throw new Error("Failed to close CPI digest");
    }

    return manageTxResult;
  }
}
