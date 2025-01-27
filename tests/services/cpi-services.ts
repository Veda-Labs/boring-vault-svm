import {
    PublicKey,
    AccountMeta,
  } from "@solana/web3.js";
export class CpiService {
    static getJitoSolDepositAccounts(params: {
      stakePool: PublicKey,
      withdrawAuth: PublicKey,
      reserve: PublicKey,
      vault: PublicKey,
      vaultAta: PublicKey,
      fee: PublicKey,
      jitoSol: PublicKey,
      systemProgram: PublicKey,
      tokenProgram: PublicKey,
      stakePoolProgram: PublicKey,
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
          { ingestInstruction: {0: 0, 1: 1}},
          { ingestAccount: 0},
          { ingestAccount: 1},
          { ingestAccount: 2},
          { ingestAccount: 3},
          { ingestAccount: 4},
          { ingestAccount: 5},
          { ingestAccount: 6},
          { ingestAccount: 7},
          { ingestAccount: 8},
          { ingestAccount: 9}
        ],
      };
    }

    static getWSolTransferOperators() {
        return {
          operators: [
            { ingestAccount: 0},
            { ingestAccount: 1}
          ],
        };
      }

      static getWSolWrapOperators() {
        return {
          operators: [
            { ingestInstruction: {0: 0, 1: 1}},
            { ingestAccount: 0}
          ],
        };
      }
  }