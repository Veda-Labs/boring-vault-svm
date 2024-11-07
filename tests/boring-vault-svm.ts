import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { Program } from "@coral-xyz/anchor";
import { BoringBridgeHolder } from "../target/types/boring_bridge_holder";
import { expect } from "chai";
import { ComputeBudgetProgram } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID
} from "@solana/spl-token";
import {
  AddedAccount,
  BanksClient,
  BanksTransactionResultWithMeta,
  ProgramTestContext,
} from "solana-bankrun";
import {
  PublicKey,
  Transaction,
  Keypair,
  Connection,
  TransactionInstruction
} from "@solana/web3.js";
import { BoringVaultSvm } from "../target/types/boring_vault_svm";

describe("boring-vault-svm", () => {
  let provider: BankrunProvider;
  let program: Program<BoringVaultSvm>;
  let context: ProgramTestContext;
  let client: BanksClient;
  let connection: Connection;
  let creator: anchor.web3.Keypair;

  const PROJECT_DIRECTORY = ""; // Leave empty if using default anchor project

  async function createAndProcessTransaction(
    client: BanksClient,
    payer: Keypair,
    instruction: TransactionInstruction,
    additionalSigners: Keypair[] = []
  ): Promise<BanksTransactionResultWithMeta> {
    const tx = new Transaction();
    const [latestBlockhash] = await client.getLatestBlockhash();
    tx.recentBlockhash = latestBlockhash;
    tx.add(instruction);
    tx.feePayer = payer.publicKey;
    tx.add(
      ComputeBudgetProgram.setComputeUnitLimit({
        units: 400_000,
      })
    );
    tx.sign(payer, ...additionalSigners);
    return await client.tryProcessTransaction(tx);
  }

  before(async () => {
    connection = new Connection("https://eclipse.helius-rpc.com");

    // Set up bankrun context
    context = await startAnchor(
      PROJECT_DIRECTORY,
      [],
      []
    );
    client = context.banksClient;
    provider = new BankrunProvider(context);
    creator = context.payer;
    anchor.setProvider(provider);
    program = anchor.workspace.BoringVaultSvm as Program<BoringVaultSvm>;
  });

  it("Serializes operators!", async () => {
    // Add your test here.
    const ix = await program.methods
      .serializeOperators(
        [
          { base: { ingest: { start: 0, length: 1 } } },
          { base: { size: {} } },
          { base: { assertBytes1: { start: 0, expected: Buffer.from([0]) } } },
          { base: { assertBytes2: { start: 0, expected: Buffer.from([0, 1]) } } },
          { base: { assertBytes4: { start: 0, expected: Buffer.from([0, 1, 2, 3]) } } },
          { base: { assertBytes8: { start: 0, expected: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]) } } },
          { base: { assertBytes32: { start: 0, expected: Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31]) } } },
          { base: { noop: {} } }
        ]
      )
      .accounts({
        payer: creator.publicKey,
      })
      .signers([])
      .instruction();

    // Log the instruction data size
    console.log("Instruction data size:", ix.data.length, "bytes");
    let txResult = await createAndProcessTransaction(client, creator, ix, [creator]);

    expect(txResult.result).to.be.null;
  });
});
