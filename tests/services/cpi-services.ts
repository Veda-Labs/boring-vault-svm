import {
    PublicKey,
    AccountMeta,
    Transaction,
    TransactionInstruction,
    Keypair,
  } from "@solana/web3.js";

  import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { Program } from "@coral-xyz/anchor";
import { BoringVaultSvm } from "../../target/types/boring_vault_svm";
import { expect } from "chai";
import { ComputeBudgetProgram } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID
} from "@solana/spl-token";
import {
  AddedAccount,
  BanksClient,
  BanksTransactionResultWithMeta,
  ProgramTestContext,
} from "solana-bankrun";

export class CpiService {

    static async createAndProcessTransaction(
        client: BanksClient,
        payer: Keypair,
        instruction: TransactionInstruction,
        additionalSigners: Keypair[] = []
      ): Promise<BanksTransactionResultWithMeta> {
        const tx = new Transaction();
        const [latestBlockhash] = await client.getLatestBlockhash();
        tx.recentBlockhash = latestBlockhash;
        tx.feePayer = payer.publicKey;
        tx.add(instruction);
        tx.add(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: 1_400_000,
          })
        );
        tx.sign(payer, ...additionalSigners);
        return await client.tryProcessTransaction(tx);
      }

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

      static async executeCpi(
        params: {
          program: Program<BoringVaultSvm>,
          client: BanksClient,
          deployer: Keypair,
          authority: Keypair,
          strategist: Keypair,
          vaultId: anchor.BN,
          ixProgramId: PublicKey,
          ixData: Buffer,
          operators: any[],
          expectedSize: number,
          accounts: {
            boringVaultState: PublicKey,
            boringVault: PublicKey,
          }
        },
        remainingAccounts: AccountMeta[]
      ): Promise<BanksTransactionResultWithMeta> {
        // 1. View CPI Digest
        const view_ix = await params.program.methods
          .viewCpiDigest(
            // @ts-ignore
            {
                vaultId: params.vaultId,
                ixProgramId: params.ixProgramId,
                ixData: params.ixData,
                operators: params.operators,
                expectedSize: params.expectedSize,
            }
        )
          .signers([params.deployer])
          .remainingAccounts(remainingAccounts)
          .view();
    
        const digest = view_ix.digest;
    
        // 2. Find CPI Digest Account
        const [cpiDigestAccount] = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from("cpi-digest"),
            params.accounts.boringVaultState.toBuffer(),
            Buffer.from(digest),
          ],
          params.program.programId
        );
    
        // 3. Update CPI Digest
        const updateIx = await params.program.methods
          .updateCpiDigest({
            vaultId: params.vaultId,
            cpiDigest: digest,
            isValid: true,
          })
          .accounts({
            signer: params.authority.publicKey,
            boringVaultState: params.accounts.boringVaultState,
            // @ts-ignore
            systemProgram: anchor.web3.SystemProgram.programId,
            cpiDigest: cpiDigestAccount,
          })
          .instruction();
    
        const updateTxResult = await CpiService.createAndProcessTransaction(
          params.client,
          params.deployer,
          updateIx,
          [params.authority]
        );
    
        if (updateTxResult.result !== null) {
          throw new Error("Failed to update CPI digest");
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
             operators: params.operators,
             expectedSize: params.expectedSize,
         })
         .accounts({
           signer: params.strategist.publicKey,
           boringVaultState: params.accounts.boringVaultState,
           boringVault: params.accounts.boringVault,
           cpiDigest: cpiDigestAccount,
         })
         .remainingAccounts(remainingAccounts)
         .instruction();

        return await CpiService.createAndProcessTransaction(
            params.client,
            params.deployer,
            manageIx,
            [params.strategist]
        );
    }
}