import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { BanksClient, ProgramTestContext } from "solana-bankrun";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { StateAssert } from "../target/types/state_assert";

// Load the IDL once from the file system, similar to loading keypairs in the example.
const idl = require("../target/idl/state_assert.json");

describe("state-assert", () => {
  // --- Test Context and Providers ---
  let provider: BankrunProvider;
  let program: Program<StateAssert>;
  let context: ProgramTestContext;
  let client: BanksClient;

  // --- Accounts and Keypairs ---
  let deployer: Keypair;
  let user: Keypair;
  let testDataAccount: Keypair;

  // --- PDAs and Addresses ---
  let userStack: PublicKey;

  // --- Constants ---
  const TEST_DATA_SIZE = 100;

  /**
   * This beforeEach hook ensures every test runs in a completely
   * isolated and fresh environment. We keep this vital logic while
   * organizing the variables above to match your desired structure.
   */
  beforeEach(async () => {
    // 1. Generate fresh keypairs for every single test.
    user = Keypair.generate();
    testDataAccount = Keypair.generate();

    // 2. Start a fresh, new Bankrun context, funding our new user.
    context = await startAnchor(
      "",
      [],
      [
        {
          address: user.publicKey,
          info: {
            lamports: 10_000_000_000,
            data: Buffer.alloc(0),
            owner: SystemProgram.programId,
            executable: false,
          },
        },
      ]
    );
    deployer = context.payer;
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);

    // 3. Create a brand new Program object to prevent any client-side state leakage.
    // This uses the most robust method to get the programId without making
    // assumptions about the IDL file structure.
    program = new anchor.Program<StateAssert>(idl, provider);

    // 4. Find the PDA for the user's stack account.
    [userStack] = PublicKey.findProgramAddressSync(
      [Buffer.from("stack"), user.publicKey.toBuffer()],
      program.programId
    );

    // 5. Create and fund the `testDataAccount` for use in tests.
    const createTestAccountIx = SystemProgram.createAccount({
      fromPubkey: deployer.publicKey,
      newAccountPubkey: testDataAccount.publicKey,
      lamports: await provider.connection.getMinimumBalanceForRentExemption(
        TEST_DATA_SIZE
      ),
      space: TEST_DATA_SIZE,
      programId: SystemProgram.programId,
    });
    const tx = new Transaction().add(createTestAccountIx);
    await provider.sendAndConfirm(tx, [testDataAccount]);

    // 6. Initialize the user's stack, so it exists for every test.
    await program.methods
      .setupStack()
      .accounts({
        signer: user.publicKey,
        userStack: userStack,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  });

  // Helper function to modify account data for setting up test scenarios.
  async function writeU64ToAccount(
    account: PublicKey,
    offset: number,
    value: anchor.BN
  ) {
    const accountInfo = await provider.connection.getAccountInfo(account);
    if (!accountInfo) throw new Error("Account not found");
    const data = accountInfo.data;
    value.toArrayLike(Buffer, "le", 8).copy(data, offset);
    await context.setAccount(account, { ...accountInfo, data });
  }

  describe("Push and Pop Operations", () => {
    it("Should push and pop with Log comparison", async () => {
      const dataOffset = 8;
      const initialValue = new anchor.BN(1000);
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(
          dataOffset,
          new anchor.BN(100),
          { log: {} },
          { any: {} }
        )
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        new anchor.BN(1100)
      );

      await program.methods
        .popStateAssert()
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();
    });

    it("Should enforce GT comparison", async () => {
      const dataOffset = 16;
      const initialValue = new anchor.BN(2000);
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(dataOffset, new anchor.BN(50), { gt: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        new anchor.BN(2050)
      );

      try {
        await program.methods
          .popStateAssert()
          .accounts({
            signer: user.publicKey,
            targetAccount: testDataAccount.publicKey,
            userStack: userStack,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed with AssertionFailed");
      } catch (error) {
        expect(error.toString()).to.include("AssertionFailed");
      }
    });

    it("Should enforce direction constraints", async () => {
      const dataOffset = 24;
      const initialValue = new anchor.BN(3000);
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(
          dataOffset,
          new anchor.BN(0),
          { log: {} },
          { increase: {} }
        )
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        new anchor.BN(2500)
      );

      try {
        await program.methods
          .popStateAssert()
          .accounts({
            signer: user.publicKey,
            targetAccount: testDataAccount.publicKey,
            userStack: userStack,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed with DirectionConstraintViolated");
      } catch (error) {
        expect(error.toString()).to.include("DirectionConstraintViolated");
      }
    });
    it("Should succeed with Increase direction constraint", async () => {
      const dataOffset = 24;
      const initialValue = new anchor.BN(3000);
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(
          dataOffset,
          new anchor.BN(0),
          { log: {} },
          { increase: {} }
        )
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      // Value increases, which satisfies the constraint.
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        new anchor.BN(3500)
      );

      await program.methods
        .popStateAssert()
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();
    });

    it("Should succeed with Decrease direction constraint", async () => {
      const dataOffset = 24;
      const initialValue = new anchor.BN(3000);
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(
          dataOffset,
          new anchor.BN(0),
          { log: {} },
          { decrease: {} }
        )
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      // Value decreases, which satisfies the constraint.
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        new anchor.BN(2500)
      );

      await program.methods
        .popStateAssert()
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();
    });
    it("Should successfully assert GT", async () => {
      const dataOffset = 16;
      const initialValue = new anchor.BN(2000);
      const changeAmount = new anchor.BN(100);
      const compareTo = new anchor.BN(50); // 100 > 50, so this should pass
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(dataOffset, compareTo, { gt: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      // Change the value by 100
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue.add(changeAmount)
      );

      // This should succeed because 100 > 50
      await program.methods
        .popStateAssert()
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();
    });
    it("Should successfully assert GTE (equal case)", async () => {
      const dataOffset = 8;
      const initialValue = new anchor.BN(1000);
      const changeAmount = new anchor.BN(50);
      const compareTo = new anchor.BN(50); // 50 >= 50, should pass
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(dataOffset, compareTo, { gte: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue.add(changeAmount)
      );

      await program.methods
        .popStateAssert()
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();
    });
    it("Should successfully assert LTE (less than case)", async () => {
      const dataOffset = 8;
      const initialValue = new anchor.BN(1000);
      const changeAmount = new anchor.BN(49);
      const compareTo = new anchor.BN(50); // 49 <= 50, should pass
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(dataOffset, compareTo, { lte: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue.add(changeAmount)
      );

      await program.methods
        .popStateAssert()
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();
    });
    it("Should successfully assert LT", async () => {
      const dataOffset = 8;
      const initialValue = new anchor.BN(1000);
      const changeAmount = new anchor.BN(40);
      const compareTo = new anchor.BN(50); // 40 < 50, so this should pass
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(dataOffset, compareTo, { lt: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue.add(changeAmount)
      );

      // This should succeed
      await program.methods
        .popStateAssert()
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();
    });

    it("Should fail to assert LT", async () => {
      const dataOffset = 8;
      const initialValue = new anchor.BN(1000);
      const changeAmount = new anchor.BN(60);
      const compareTo = new anchor.BN(50); // 60 is not < 50
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(dataOffset, compareTo, { lt: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue.add(changeAmount)
      );

      try {
        await program.methods
          .popStateAssert()
          .accounts({
            signer: user.publicKey,
            targetAccount: testDataAccount.publicKey,
            userStack: userStack,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed with AssertionFailed");
      } catch (error) {
        expect(error.toString()).to.include("AssertionFailed");
      }
    });
    it("Should successfully assert EQ", async () => {
      const dataOffset = 8;
      const initialValue = new anchor.BN(1000);
      const changeAmount = new anchor.BN(50);
      const compareTo = new anchor.BN(50); // 50 == 50, should pass
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(dataOffset, compareTo, { eq: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue.add(changeAmount)
      );

      await program.methods
        .popStateAssert()
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();
    });
  });

  describe("Error Cases", () => {
    it("Should fail on empty stack", async () => {
      const stackAccount = await program.account.stateAssertStack.fetch(
        userStack
      );
      expect(stackAccount.len).to.equal(0);

      try {
        await program.methods
          .popStateAssert()
          .accounts({
            signer: user.publicKey,
            targetAccount: testDataAccount.publicKey,
            userStack: userStack,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed with EmptyStack");
      } catch (error) {
        expect(error.toString()).to.include("EmptyStack");
      }
    });

    it("Should fail on stack overflow", async () => {
      let stackAccount = await program.account.stateAssertStack.fetch(
        userStack
      );
      expect(stackAccount.len).to.equal(0);

      for (let i = 0; i < 16; i++) {
        await program.methods
          .pushStateAssert(8, new anchor.BN(i), { eq: {} }, { any: {} })
          .accounts({
            signer: user.publicKey,
            targetAccount: testDataAccount.publicKey,
            userStack: userStack,
          })
          .signers([user])
          .rpc();
      }

      stackAccount = await program.account.stateAssertStack.fetch(userStack);
      expect(stackAccount.len).to.equal(16);

      try {
        await program.methods
          .pushStateAssert(8, new anchor.BN(999), { eq: {} }, { any: {} })
          .accounts({
            signer: user.publicKey,
            targetAccount: testDataAccount.publicKey,
            userStack: userStack,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed with StackOverflow");
      } catch (error) {
        expect(error.toString()).to.include("StackOverflow");
      }
    });
    it("Should fail on account mismatch during pop", async () => {
      // Create a second data account
      const anotherAccount = Keypair.generate();
      const createTestAccountIx = SystemProgram.createAccount({
        fromPubkey: deployer.publicKey,
        newAccountPubkey: anotherAccount.publicKey,
        lamports: await provider.connection.getMinimumBalanceForRentExemption(
          TEST_DATA_SIZE
        ),
        space: TEST_DATA_SIZE,
        programId: SystemProgram.programId,
      });
      const tx = new Transaction().add(createTestAccountIx);
      await provider.sendAndConfirm(tx, [anotherAccount]);

      // Push an assertion against the ORIGINAL testDataAccount
      await program.methods
        .pushStateAssert(8, new anchor.BN(100), { log: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      try {
        // Attempt to pop using the WRONG account
        await program.methods
          .popStateAssert()
          .accounts({
            signer: user.publicKey,
            targetAccount: anotherAccount.publicKey,
            userStack: userStack,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed with AccountMismatch");
      } catch (error) {
        expect(error.toString()).to.include("AccountMismatch");
      }
    });
    it("Should fail with invalid data offset", async () => {
      // TEST_DATA_SIZE is 100. An offset of 95 requires reading up to byte 103 (95 + 8), which is out of bounds.
      const invalidOffset = 95;

      try {
        await program.methods
          .pushStateAssert(
            invalidOffset,
            new anchor.BN(100),
            { log: {} },
            { any: {} }
          )
          .accounts({
            signer: user.publicKey,
            targetAccount: testDataAccount.publicKey,
            userStack: userStack,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed with InvalidDataOffset");
      } catch (error) {
        expect(error.toString()).to.include("InvalidDataOffset");
      }
    });
  });
  describe("Edge Cases", () => {
    it("Should fail GT comparison when value does not change", async () => {
      const dataOffset = 8;
      const initialValue = new anchor.BN(5000);
      const compareTo = new anchor.BN(0); // Assert the change is > 0
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(dataOffset, compareTo, { gt: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      // The value does not change
      // The difference will be 0, which is NOT > 0.

      try {
        await program.methods
          .popStateAssert()
          .accounts({
            signer: user.publicKey,
            targetAccount: testDataAccount.publicKey,
            userStack: userStack,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed because the difference is not > 0");
      } catch (error) {
        expect(error.toString()).to.include("AssertionFailed");
      }
    });

    it("Should pass GTE and LTE comparisons when value does not change", async () => {
      const dataOffset = 8;
      const initialValue = new anchor.BN(5000);
      const compareTo = new anchor.BN(0); // Assert the change is >= 0 or <= 0
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      // Test GTE
      await program.methods
        .pushStateAssert(dataOffset, compareTo, { gte: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      await program.methods
        .popStateAssert()
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc(); // Should succeed as 0 >= 0

      // Test LTE
      await program.methods
        .pushStateAssert(dataOffset, compareTo, { lte: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      await program.methods
        .popStateAssert()
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc(); // Should succeed as 0 <= 0
    });
    it("Should fail on pop if account data is shrunk after push", async () => {
      const dataOffset = 50; // A valid offset initially
      const initialValue = new anchor.BN(100);
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      // Push the assertion successfully
      await program.methods
        .pushStateAssert(dataOffset, new anchor.BN(10), { eq: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      // Now, let's simulate the account being maliciously shrunk
      const accountInfo = await provider.connection.getAccountInfo(
        testDataAccount.publicKey
      );
      const shrunkenData = Buffer.alloc(40); // smaller than the required 50 + 8
      accountInfo.data.copy(shrunkenData, 0, 0, 40);
      await context.setAccount(testDataAccount.publicKey, {
        ...accountInfo,
        data: shrunkenData,
      });

      try {
        await program.methods
          .popStateAssert()
          .accounts({
            signer: user.publicKey,
            targetAccount: testDataAccount.publicKey,
            userStack: userStack,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed with InvalidDataOffset on pop");
      } catch (error) {
        expect(error.toString()).to.include("InvalidDataOffset");
      }
    });
    it("Should assert EQ correctly with a decrease in value", async () => {
      const dataOffset = 8;
      const initialValue = new anchor.BN(1000);
      const changeAmount = new anchor.BN(50);
      const compareTo = new anchor.BN(50); // The absolute difference should be 50
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue
      );

      await program.methods
        .pushStateAssert(dataOffset, compareTo, { eq: {} }, { any: {} })
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();

      // Decrease the value. The absolute difference is still 50.
      await writeU64ToAccount(
        testDataAccount.publicKey,
        dataOffset,
        initialValue.sub(changeAmount)
      );

      // This should succeed because abs(950 - 1000) == 50
      await program.methods
        .popStateAssert()
        .accounts({
          signer: user.publicKey,
          targetAccount: testDataAccount.publicKey,
          userStack: userStack,
        })
        .signers([user])
        .rpc();
    });
  });
});
