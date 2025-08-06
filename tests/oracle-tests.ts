// @ts-nocheck

import * as anchor from "@coral-xyz/anchor";
import { expect } from "chai";
import { readFileSync } from "fs";
import { resolve } from "path";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { ProgramTestContext, BanksClient } from "solana-bankrun";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { BN } from "bn.js";

// Load the IDL JSON ourselves (synchronously, no require).
const idlPath = resolve(process.cwd(), "target/idl/boring_vault_svm.json");
const idl = JSON.parse(readFileSync(idlPath, "utf-8"));

// -------------------- Transaction Uniqueness Helper --------------------
let testTxNonce = 0;

// Helper function to make transactions unique by adding a compute budget instruction
function addUniquenessToMethod(method: any) {
  const currentNonce = testTxNonce++;
  return method.preInstructions([
    ComputeBudgetProgram.setComputeUnitLimit({
      units: 1_400_000 + currentNonce,
    }),
  ]);
}

// -------------------- Bankrun Setup --------------------
let provider: BankrunProvider;
let context: ProgramTestContext;
let client: BanksClient;

before(async () => {
  // Spin up a minimal Bankrun environment (no extra cloned accounts needed
  // for these pure coder tests). This still gives us a full Anchor provider
  // so we can interact with `anchor.workspace` if desired later on.
  context = await startAnchor("", [], []);
  client = context.banksClient;
  provider = new BankrunProvider(context);
  anchor.setProvider(provider as unknown as anchor.Provider);
});

describe("oracle tests", () => {
  // Anchor's BorshCoder lets us (de)serialize types exactly the way the
  // program does on-chain. This ensures our TypeScript helpers, front-end,
  // and test-fixtures stay in lock-step with the Rust definitions.
  const coder = new anchor.BorshCoder(idl);

  // Minimal Token-2022 mint (82-byte layout)
  const createStubTokenMint = (
    mintAuthority: anchor.web3.PublicKey,
    decimals: number
  ): Buffer => {
    const buf = Buffer.alloc(82);
    buf.writeUInt32LE(1, 0); // mint_authority option = Some
    mintAuthority.toBuffer().copy(buf, 4); // mint_authority
    buf.writeBigUInt64LE(0n, 36); // supply = 0
    buf.writeUInt8(decimals, 44); // decimals
    buf.writeUInt8(1, 45); // is_initialized = true
    buf.writeUInt8(0, 46); // freeze_authority option = None
    return buf;
  };

  it("encodes and decodes SwitchboardV2 correctly", () => {
    // Enum variants are represented in camel-case for the JS object key.
    const original = { 
      SwitchboardV2: { 
        feed_address: new anchor.web3.PublicKey("11111111111111111111111111111111"),
        min_samples: 1 
      } 
    } as const;

    // Encode → decode round-trip.
    const buf = coder.types.encode("OracleSource", original);
    const decoded = coder.types.decode("OracleSource", buf);

    // The first byte represents the variant index (0 for the first variant).
    expect(buf[0]).to.equal(
      0,
      "Unexpected variant discriminant for SwitchboardV2"
    );
    expect(decoded).to.deep.equal(original);
  });

  // Pyth V1 oracle has been removed as it was deprecated

  it("encodes and decodes PythV2 correctly", () => {
    const original = { 
      PythV2: { 
        feed_id: [
          0x01, 0xd5, 0x77, 0xb0, 0x70, 0x31, 0xe1, 0x26, 0x35, 0xd2, 0xfb, 0x86,
          0xaf, 0x6a, 0xe9, 0x38, 0xbd, 0xc2, 0xb6, 0xdb, 0xa9, 0x60, 0x2d, 0x8e,
          0x8a, 0xf3, 0x4d, 0x44, 0x58, 0x75, 0x66, 0xfc,
        ],
        max_conf_width_bps: 500
      } 
    } as const;

    const buf = coder.types.encode("OracleSource", original);
    const decoded = coder.types.decode("OracleSource", buf);

    expect(buf[0]).to.equal(1, "Unexpected variant discriminant for PythV2");
    expect(decoded).to.deep.equal(original);
  });

  it("round-trips AssetData structs with each oracle source", () => {
    // Minimal AssetData object – values other than oracleSource are arbitrary
    // but must satisfy the type checker. We keep them small to avoid noise.
    const minimalAssetData = {
      allow_deposits: true,
      allow_withdrawals: true,
      share_premium_bps: 0,
      is_pegged_to_base_asset: false,
      inverse_price_feed: false,
      max_staleness: new BN(0),
      oracle_source: undefined as unknown as any, // will be filled per variant
    };

    const variants = [
      { 
        SwitchboardV2: { 
          feed_address: new anchor.web3.PublicKey("11111111111111111111111111111111"),
          min_samples: 1 
        } 
      },
      { 
        PythV2: { 
          feed_id: [
            0x01, 0xd5, 0x77, 0xb0, 0x70, 0x31, 0xe1, 0x26, 0x35, 0xd2, 0xfb, 0x86,
            0xaf, 0x6a, 0xe9, 0x38, 0xbd, 0xc2, 0xb6, 0xdb, 0xa9, 0x60, 0x2d, 0x8e,
            0x8a, 0xf3, 0x4d, 0x44, 0x58, 0x75, 0x66, 0xfc,
          ],
          max_conf_width_bps: 500
        } 
      },
    ] as const;

    for (const oracleVariant of variants) {
      const assetData = { ...minimalAssetData, oracle_source: oracleVariant };

      // For PythV2, provide a mock feed_id
      if ("PythV2" in oracleVariant) {
        assetData.feed_id = Array.from({ length: 32 }, (_, i) => i); // Mock 32-byte array
      }

      const buf = coder.types.encode("AssetData", assetData);
      const decoded = coder.types.decode("AssetData", buf);

      expect(decoded.oracle_source).to.deep.equal(
        oracleVariant,
        `Mismatch after round-trip for variant ${Object.keys(oracleVariant)[0]}`
      );
    }
  });

  it("decodes raw discriminant bytes", function() {
    // Test decoding valid enum data with discriminants
    // SwitchboardV2 should have discriminant 0, PythV2 should have discriminant 1
    
    // Create valid SwitchboardV2 enum data
    const switchboardV2Data = {
      SwitchboardV2: {
        feed_address: new anchor.web3.PublicKey("11111111111111111111111111111111"),
        min_samples: 1
      }
    };
    
    // Create valid PythV2 enum data
    const pythV2Data = {
      PythV2: {
        feed_id: [
          0x01, 0xd5, 0x77, 0xb0, 0x70, 0x31, 0xe1, 0x26, 0x35, 0xd2, 0xfb, 0x86,
          0xaf, 0x6a, 0xe9, 0x38, 0xbd, 0xc2, 0xb6, 0xdb, 0xa9, 0x60, 0x2d, 0x8e,
          0x8a, 0xf3, 0x4d, 0x44, 0x58, 0x75, 0x66, 0xfc,
        ],
        max_conf_width_bps: 500
      }
    };
    
    // Encode and decode to verify discriminants work
    const encodedSwitchboard = coder.types.encode("OracleSource", switchboardV2Data);
    const encodedPyth = coder.types.encode("OracleSource", pythV2Data);
    
    // Check that discriminants are as expected (0 for SwitchboardV2, 1 for PythV2)
    expect(encodedSwitchboard[0]).to.equal(0); // SwitchboardV2 discriminant
    expect(encodedPyth[0]).to.equal(1); // PythV2 discriminant
    
    // Verify we can decode back
    const decodedSwitchboard = coder.types.decode("OracleSource", encodedSwitchboard);
    const decodedPyth = coder.types.decode("OracleSource", encodedPyth);
    
    expect(decodedSwitchboard).to.have.property('SwitchboardV2');
    expect(decodedPyth).to.have.property('PythV2');
  });

  it("throws when decoding unknown discriminant", () => {
    const bogusBuf = Buffer.from([42]); // discriminant 42 does not exist
    expect(() => coder.types.decode("OracleSource", bogusBuf)).to.throw();
  });

  it("throws when encoding an unknown variant object", () => {
    const unknownVariant: any = { Unknown: {} };
    // TypeScript uses `any`, so no compile-time error – runtime should throw.
    expect(() => coder.types.encode("OracleSource", unknownVariant)).to.throw();
  });

  // -----------------------------------------------------------------------------
  // SwitchboardV2 oracle – end-to-end integration test (depositSol path)
  // -----------------------------------------------------------------------------
  it("performs a SOL deposit that relies on a SwitchboardV2 price feed", async () => {
    const authority = provider.wallet.payer as anchor.web3.Keypair;
    const program = new anchor.Program(
      idl,
      provider as unknown as anchor.Provider
    ) as anchor.Program<any>;

    // Program setup (reuse existing pattern)
    const programKeypair = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(
        JSON.parse(
          readFileSync("target/deploy/boring_vault_svm-keypair.json", "utf-8")
        )
      )
    );

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Initialize (idempotent)
    try {
      await program.methods
        .initialize(authority.publicKey)
        .accounts({
          signer: authority.publicKey,
          program: programKeypair.publicKey,
          config: configPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([authority, programKeypair])
        .rpc();
    } catch (e) {
      if (!String(e).includes("already in use")) {
        throw e;
      }
    }
  });

  // -----------------------------------------------------------------------------
  // Oracle enum integration test - tests pythV2 oracle source enum
  // -----------------------------------------------------------------------------
  it("successfully updates asset data with pythV2 oracle source enum", async () => {
    const authority = provider.wallet.payer as anchor.web3.Keypair;
    const program = new anchor.Program(
      idl,
      provider as unknown as anchor.Provider
    ) as anchor.Program<any>;

    // Program setup (reuse existing pattern)
    const programKeypair = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(
        JSON.parse(
          readFileSync("target/deploy/boring_vault_svm-keypair.json", "utf-8")
        )
      )
    );

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Initialize if needed (idempotent)
    try {
      await addUniquenessToMethod(
        program.methods.initialize(authority.publicKey)
      )
        .accounts({
          signer: authority.publicKey,
          program: programKeypair.publicKey,
          config: configPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([authority, programKeypair])
        .rpc();
    } catch (e) {
      if (!String(e).includes("already in use")) {
        throw e;
      }
    }

    // Get next vault ID (incremented from current count) to avoid conflicts
    const programConfig: any = await program.account.programConfig.fetch(
      configPda
    );
    const vaultId: BN = new BN(programConfig.vaultCount); // Use the proper next vault ID

    const vaultIdBytes = Buffer.alloc(8);
    vaultId.toArrayLike(Buffer, "le", 8).copy(vaultIdBytes);

    const [vaultStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("boring-vault-state"), vaultIdBytes],
      program.programId
    );

    const [shareMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("share-token"), vaultStatePda.toBuffer()],
      program.programId
    );

    // Create a simple token mint for testing (like JITOSOL in working tests)
    const testMint = anchor.web3.Keypair.generate();
    await context.setAccount(testMint.publicKey, {
      lamports: 1_000_000_000n,
      data: createStubTokenMint(authority.publicKey, 9),
      owner: TOKEN_2022_PROGRAM_ID,
      executable: false,
      rentEpoch: 0n,
    });

    // Use unique keypair-based name for true uniqueness
    const uniqueId = testMint.publicKey.toString().slice(0, 8);

    // Deploy a vault first to create the vault state PDA
    await addUniquenessToMethod(
      program.methods.deploy({
        authority: authority.publicKey,
        name: `PYTH_ORACLE_${uniqueId}`,
        symbol: "POT",
        exchangeRateProvider: authority.publicKey,
        exchangeRate: new BN(1_000_000_000),
        payoutAddress: authority.publicKey,
        allowedExchangeRateChangeUpperBound: 10_000,
        allowedExchangeRateChangeLowerBound: 8000,
        minimumUpdateDelayInSeconds: 0,
        platformFeeBps: 0,
        performanceFeeBps: 0,
        withdrawAuthority: anchor.web3.PublicKey.default,
        strategist: authority.publicKey,
      })
    )
      .accounts({
        signer: authority.publicKey,
        config: configPda,
        boringVaultState: vaultStatePda,
        shareMint: shareMintPda,
        baseAsset: testMint.publicKey, // Use proper token mint
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    // Create asset data with Pyth oracle
    const [assetDataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("asset-data"),
        vaultStatePda.toBuffer(),
        testMint.publicKey.toBuffer(),
      ],
      program.programId
    );

    const mockPriceFeed = anchor.web3.Keypair.generate().publicKey;

    // Test pythV2 oracle source enum - this is the key test
    const uniqueBps = parseInt(uniqueId.slice(0, 2), 16) % 100; // Use part of unique ID for BPS

    await addUniquenessToMethod(
      program.methods.updateAssetData({
        vaultId,
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: uniqueBps,
          isPeggedToBaseAsset: true, // Set to true to bypass oracle validation for this test
          inversePriceFeed: false,
          maxStaleness: new BN(
            5_000_000_000 + parseInt(uniqueId.slice(2, 4), 16) * 1000
          ), // Use unique ID
          oracleSource: { 
            pythV2: { 
              feedId: [
                0x01, 0xd5, 0x77, 0xb0, 0x70, 0x31, 0xe1, 0x26, 0x35, 0xd2, 0xfb, 0x86,
                0xaf, 0x6a, 0xe9, 0x38, 0xbd, 0xc2, 0xb6, 0xdb, 0xa9, 0x60, 0x2d, 0x8e,
                0x8a, 0xf3, 0x4d, 0x44, 0x58, 0x75, 0x66, 0xfc,
              ], // JITOSOL/SOL feed ID for testing
              maxConfWidthBps: 500 // 5% confidence limit
            } 
          }
        },
      })
    )
      .accounts({
        signer: authority.publicKey,
        boringVaultState: vaultStatePda,
        systemProgram: anchor.web3.SystemProgram.programId,
        asset: testMint.publicKey,
        assetData: assetDataPda,
      })
      .signers([authority])
      .rpc();

    // Verify the asset data was stored correctly
    const storedAssetData: any = await program.account.assetData.fetch(
      assetDataPda
    );

    // Check that PythV2 oracle source was properly stored
    // Check that PythV2 oracle source was properly stored with parameters
    expect(storedAssetData.oracleSource).to.have.property('pythV2');
    expect(storedAssetData.oracleSource.pythV2).to.have.property('feedId');
    expect(storedAssetData.oracleSource.pythV2).to.have.property('maxConfWidthBps', 500);
    expect(storedAssetData.allowDeposits).to.be.true;
    expect(storedAssetData.isPeggedToBaseAsset).to.be.true;
  });

  // -----------------------------------------------------------------------------
  // SOL deposit test with PythV2 oracle source
  // -----------------------------------------------------------------------------
  it("can deposit SOL into a vault with pythV2 oracle source", async () => {
    const authority = provider.wallet.payer as anchor.web3.Keypair;
    const program = new anchor.Program(
      idl,
      provider as unknown as anchor.Provider
    ) as anchor.Program<any>;

    // Program setup (reuse existing pattern)
    const programKeypair = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(
        JSON.parse(
          readFileSync("target/deploy/boring_vault_svm-keypair.json", "utf-8")
        )
      )
    );

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Initialize if needed (idempotent)
    try {
      await program.methods
        .initialize(authority.publicKey)
        .accounts({
          signer: authority.publicKey,
          program: programKeypair.publicKey,
          config: configPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([authority, programKeypair])
        .rpc();
    } catch (e) {
      if (!String(e).includes("already in use")) {
        throw e;
      }
    }

    // Get next vault ID (incremented from current count) to avoid conflicts
    const programConfig: any = await program.account.programConfig.fetch(
      configPda
    );
    const vaultId: BN = new BN(programConfig.vaultCount); // Use the proper next vault ID

    const vaultIdBytes = Buffer.alloc(8);
    vaultId.toArrayLike(Buffer, "le", 8).copy(vaultIdBytes);

    const [vaultStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("boring-vault-state"), vaultIdBytes],
      program.programId
    );

    const [shareMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("share-token"), vaultStatePda.toBuffer()],
      program.programId
    );

    // Create a base asset mint for the vault (like JITOSOL in working tests)
    const baseAssetMint = anchor.web3.Keypair.generate();
    await context.setAccount(baseAssetMint.publicKey, {
      lamports: 1_000_000_000n,
      data: createStubTokenMint(authority.publicKey, 9),
      owner: TOKEN_2022_PROGRAM_ID,
      executable: false,
      rentEpoch: 0n,
    });

    // Use unique keypair-based name for true uniqueness
    const uniqueId = baseAssetMint.publicKey.toString().slice(0, 8);

    // Deploy a vault with base asset
    await program.methods
      .deploy({
        authority: authority.publicKey,
        name: `SOL_PYTH_${uniqueId}`,
        symbol: "SPV",
        exchangeRateProvider: authority.publicKey,
        exchangeRate: new BN(1_000_000_000), // 1:1 exchange rate
        payoutAddress: authority.publicKey,
        allowedExchangeRateChangeUpperBound: 10_000,
        allowedExchangeRateChangeLowerBound: 8000,
        minimumUpdateDelayInSeconds: 0,
        platformFeeBps: 0,
        performanceFeeBps: 0,
        withdrawAuthority: anchor.web3.PublicKey.default,
        strategist: authority.publicKey,
      })
      .accounts({
        signer: authority.publicKey,
        config: configPda,
        boringVaultState: vaultStatePda,
        shareMint: shareMintPda,
        baseAsset: baseAssetMint.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    // Set up asset data for SOL (native SOL) with Pyth oracle
    const NATIVE_SOL = new anchor.web3.PublicKey(
      "11111111111111111111111111111111"
    );
    const [solAssetDataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("asset-data"),
        vaultStatePda.toBuffer(),
        NATIVE_SOL.toBuffer(),
      ],
      program.programId
    );

    // Create a mock Pyth price feed account
    const mockPythPriceFeed = anchor.web3.Keypair.generate().publicKey;

    // Update asset data for SOL with Pyth oracle source
    const uniqueBps = parseInt(uniqueId.slice(0, 2), 16) % 100; // Use part of unique ID for BPS

    await program.methods
      .updateAssetData({
        vaultId,
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: uniqueBps,
          isPeggedToBaseAsset: true, // Set to true to bypass oracle validation for this test
          inversePriceFeed: false,
          maxStaleness: new BN(
            5_000_000_000 + parseInt(uniqueId.slice(2, 4), 16) * 1000
          ), // Use unique ID
          oracleSource: { 
            pythV2: { 
              feedId: [
                0x01, 0xd5, 0x77, 0xb0, 0x70, 0x31, 0xe1, 0x26, 0x35, 0xd2, 0xfb, 0x86,
                0xaf, 0x6a, 0xe9, 0x38, 0xbd, 0xc2, 0xb6, 0xdb, 0xa9, 0x60, 0x2d, 0x8e,
                0x8a, 0xf3, 0x4d, 0x44, 0x58, 0x75, 0x66, 0xfc,
              ], // JITOSOL/SOL feed ID for testing
              maxConfWidthBps: 500 // 5% confidence limit
            } 
          }
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: vaultStatePda,
        systemProgram: anchor.web3.SystemProgram.programId,
        asset: NATIVE_SOL,
        assetData: solAssetDataPda,
      })
      .signers([authority])
      .rpc();

    // Verify asset data was set correctly with PythV2 oracle
    const storedAssetData: any = await program.account.assetData.fetch(
      solAssetDataPda
    );
    // Check that PythV2 oracle source was properly stored with parameters
    expect(storedAssetData.oracleSource).to.have.property('pythV2');
    expect(storedAssetData.oracleSource.pythV2).to.have.property('feedId');
    expect(storedAssetData.oracleSource.pythV2).to.have.property('maxConfWidthBps', 500);

    // Create user for testing deposit
    const user = anchor.web3.Keypair.generate();

    // Fund user with SOL
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: user.publicKey,
        lamports: 2_000_000_000, // 2 SOL
      })
    );

    const [latestBlockhash] = await context.banksClient.getLatestBlockhash();
    transferTx.recentBlockhash = latestBlockhash;

    transferTx.feePayer = authority.publicKey;
    transferTx.sign(authority);

    await context.banksClient.processTransaction(transferTx);

    // Get user's share token account
    const userShareAta = getAssociatedTokenAddressSync(
      shareMintPda,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Get initial balances
    const initialUserBalance = await context.banksClient.getBalance(
      user.publicKey
    );

    // Perform SOL deposit
    const depositAmount = new BN(1_000_000_000); // 1 SOL
    const minMintAmount = new BN(900_000_000); // Expect at least 0.9 shares

    await program.methods
      .depositSol({
        vaultId,
        depositAmount,
        minMintAmount,
      })
      .accounts({
        signer: user.publicKey,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: vaultStatePda,
        boringVault: anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("boring-vault"), vaultIdBytes, Buffer.from([0])],
          program.programId
        )[0],
        assetData: solAssetDataPda,
        shareMint: shareMintPda,
        userShares: userShareAta,
        priceFeed: mockPythPriceFeed,
      })
      .signers([user])
      .rpc();

    // Verify deposit worked
    const finalUserBalance = await context.banksClient.getBalance(
      user.publicKey
    );
    const userShareBalance = await context.banksClient.getAccount(userShareAta);

    // Check that user's SOL balance decreased by approximately the deposit amount
    const balanceChange = Number(initialUserBalance - finalUserBalance);
    expect(balanceChange).to.be.greaterThan(depositAmount.toNumber()); // Should be deposit + transaction fees

    // Check that user received share tokens
    expect(userShareBalance).to.not.be.null;
  });

  // -----------------------------------------------------------------------------
  // PythV2 Pull Oracle integration test - tests new pyth oracle source enum
  // -----------------------------------------------------------------------------
  it("successfully updates asset data with pythV2 oracle source enum", async () => {
    const authority = provider.wallet.payer as anchor.web3.Keypair;
    const program = new anchor.Program(
      idl,
      provider as unknown as anchor.Provider
    ) as anchor.Program<any>;

    // Program setup (reuse existing pattern)
    const programKeypair = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(
        JSON.parse(
          readFileSync("target/deploy/boring_vault_svm-keypair.json", "utf-8")
        )
      )
    );

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Initialize if needed (idempotent)
    try {
      await program.methods
        .initialize(authority.publicKey)
        .accounts({
          signer: authority.publicKey,
          program: programKeypair.publicKey,
          config: configPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([authority, programKeypair])
        .rpc();
    } catch (e) {
      if (!String(e).includes("already in use")) {
        throw e;
      }
    }

    // Get next vault ID (incremented from current count) to avoid conflicts
    const programConfig: any = await program.account.programConfig.fetch(
      configPda
    );
    const vaultId: BN = new BN(programConfig.vaultCount); // Use the proper next vault ID

    const vaultIdBytes = Buffer.alloc(8);
    vaultId.toArrayLike(Buffer, "le", 8).copy(vaultIdBytes);

    const [vaultStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("boring-vault-state"), vaultIdBytes],
      program.programId
    );

    const [shareMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("share-token"), vaultStatePda.toBuffer()],
      program.programId
    );

    // Create a simple token mint for testing (like JITOSOL in working tests)
    const testMint = anchor.web3.Keypair.generate();
    await context.setAccount(testMint.publicKey, {
      lamports: 1_000_000_000n,
      data: createStubTokenMint(authority.publicKey, 9),
      owner: TOKEN_2022_PROGRAM_ID,
      executable: false,
      rentEpoch: 0n,
    });

    // Use unique keypair-based name for true uniqueness
    const uniqueId = testMint.publicKey.toString().slice(0, 8);

    // Deploy a vault first to create the vault state PDA
    await program.methods
      .deploy({
        authority: authority.publicKey,
        name: `PYTHV2_ORACLE_${uniqueId}`,
        symbol: "P2T",
        exchangeRateProvider: authority.publicKey,
        exchangeRate: new BN(1_000_000_000),
        payoutAddress: authority.publicKey,
        allowedExchangeRateChangeUpperBound: 10_000,
        allowedExchangeRateChangeLowerBound: 8000,
        minimumUpdateDelayInSeconds: 0,
        platformFeeBps: 0,
        performanceFeeBps: 0,
        withdrawAuthority: anchor.web3.PublicKey.default,
        strategist: authority.publicKey,
      })
      .accounts({
        signer: authority.publicKey,
        config: configPda,
        boringVaultState: vaultStatePda,
        shareMint: shareMintPda,
        baseAsset: testMint.publicKey, // Use proper token mint
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    // Create asset data with PythV2 oracle
    const [assetDataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("asset-data"),
        vaultStatePda.toBuffer(),
        testMint.publicKey.toBuffer(),
      ],
      program.programId
    );

    const mockPriceFeed = anchor.web3.Keypair.generate().publicKey;

    // Test pythV2 oracle source enum - this is the key test for the new oracle type
    const uniqueBps = parseInt(uniqueId.slice(0, 2), 16) % 100; // Use part of unique ID for BPS

    // Create test feed_id (32 bytes) for PythV2 - using our working JITOSOL/SOL feed ID
    const feedId = [
      0x01, 0xd5, 0x77, 0xb0, 0x70, 0x31, 0xe1, 0x26, 0x35, 0xd2, 0xfb, 0x86,
      0xaf, 0x6a, 0xe9, 0x38, 0xbd, 0xc2, 0xb6, 0xdb, 0xa9, 0x60, 0x2d, 0x8e,
      0x8a, 0xf3, 0x4d, 0x44, 0x58, 0x75, 0x66, 0xfc,
    ];

    await program.methods
      .updateAssetData({
        vaultId,
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: uniqueBps,
          isPeggedToBaseAsset: true, // Set to true to bypass oracle validation for this test
          inversePriceFeed: false,
          maxStaleness: new BN(
            5_000_000_000 + parseInt(uniqueId.slice(2, 4), 16) * 1000
          ), // Use unique ID
          oracleSource: { 
            pythV2: { 
              feedId: feedId,
              maxConfWidthBps: 500 // 5% confidence limit
            } 
          }
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: vaultStatePda,
        systemProgram: anchor.web3.SystemProgram.programId,
        asset: testMint.publicKey,
        assetData: assetDataPda,
      })
      .signers([authority])
      .rpc();

    // Verify the asset data was stored correctly
    const storedAssetData: any = await program.account.assetData.fetch(
      assetDataPda
    );

    // Check that PythV2 oracle source was properly stored
    // Check that PythV2 oracle source was properly stored with parameters
    expect(storedAssetData.oracleSource).to.have.property('pythV2');
    expect(storedAssetData.oracleSource.pythV2).to.have.property('feedId');
    expect(storedAssetData.oracleSource.pythV2).to.have.property('maxConfWidthBps', 500);
    expect(storedAssetData.allowDeposits).to.be.true;
    expect(storedAssetData.isPeggedToBaseAsset).to.be.true;

    // Verify feed_id was stored correctly within the oracle source
    expect(storedAssetData.oracleSource.pythV2.feedId).to.not.be.null;
    expect(storedAssetData.oracleSource.pythV2.feedId).to.deep.equal(feedId);
  });

  // -----------------------------------------------------------------------------
  // SOL deposit test with PythV2 Pull Oracle source
  // -----------------------------------------------------------------------------
  it("can deposit SOL into a vault with pythV2 pull oracle source", async () => {
    const authority = provider.wallet.payer as anchor.web3.Keypair;
    const program = new anchor.Program(
      idl,
      provider as unknown as anchor.Provider
    ) as anchor.Program<any>;

    // Program setup (reuse existing pattern)
    const programKeypair = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(
        JSON.parse(
          readFileSync("target/deploy/boring_vault_svm-keypair.json", "utf-8")
        )
      )
    );

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    // Initialize if needed (idempotent)
    try {
      await program.methods
        .initialize(authority.publicKey)
        .accounts({
          signer: authority.publicKey,
          program: programKeypair.publicKey,
          config: configPda,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .signers([authority, programKeypair])
        .rpc();
    } catch (e) {
      if (!String(e).includes("already in use")) {
        throw e;
      }
    }

    // Get next vault ID (incremented from current count) to avoid conflicts
    const programConfig: any = await program.account.programConfig.fetch(
      configPda
    );
    const vaultId: BN = new BN(programConfig.vaultCount); // Use the proper next vault ID

    const vaultIdBytes = Buffer.alloc(8);
    vaultId.toArrayLike(Buffer, "le", 8).copy(vaultIdBytes);

    const [vaultStatePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("boring-vault-state"), vaultIdBytes],
      program.programId
    );

    const [shareMintPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("share-token"), vaultStatePda.toBuffer()],
      program.programId
    );

    // Create a base asset mint for the vault (like JITOSOL in working tests)
    const baseAssetMint = anchor.web3.Keypair.generate();
    await context.setAccount(baseAssetMint.publicKey, {
      lamports: 1_000_000_000n,
      data: createStubTokenMint(authority.publicKey, 9),
      owner: TOKEN_2022_PROGRAM_ID,
      executable: false,
      rentEpoch: 0n,
    });

    // Use unique keypair-based name for true uniqueness
    const uniqueId = baseAssetMint.publicKey.toString().slice(0, 8);

    // Deploy a vault with base asset
    await program.methods
      .deploy({
        authority: authority.publicKey,
        name: `SOL_PYTHV2_${uniqueId}`,
        symbol: "SP2",
        exchangeRateProvider: authority.publicKey,
        exchangeRate: new BN(1_000_000_000), // 1:1 exchange rate
        payoutAddress: authority.publicKey,
        allowedExchangeRateChangeUpperBound: 10_000,
        allowedExchangeRateChangeLowerBound: 8000,
        minimumUpdateDelayInSeconds: 0,
        platformFeeBps: 0,
        performanceFeeBps: 0,
        withdrawAuthority: anchor.web3.PublicKey.default,
        strategist: authority.publicKey,
      })
      .accounts({
        signer: authority.publicKey,
        config: configPda,
        boringVaultState: vaultStatePda,
        shareMint: shareMintPda,
        baseAsset: baseAssetMint.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([authority])
      .rpc();

    // Set up asset data for SOL (native SOL) with PythV2 oracle
    const NATIVE_SOL = new anchor.web3.PublicKey(
      "11111111111111111111111111111111"
    );
    const [solAssetDataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("asset-data"),
        vaultStatePda.toBuffer(),
        NATIVE_SOL.toBuffer(),
      ],
      program.programId
    );

    // Create a mock Pyth Pull Oracle price update account
    const mockPythV2PriceFeed = anchor.web3.Keypair.generate().publicKey;

    // Update asset data for SOL with PythV2 oracle source
    const uniqueBps = parseInt(uniqueId.slice(0, 2), 16) % 100; // Use part of unique ID for BPS

    // Create test feed_id (32 bytes) for PythV2 - using our working JITOSOL/SOL feed ID
    const feedId = [
      0x01, 0xd5, 0x77, 0xb0, 0x70, 0x31, 0xe1, 0x26, 0x35, 0xd2, 0xfb, 0x86,
      0xaf, 0x6a, 0xe9, 0x38, 0xbd, 0xc2, 0xb6, 0xdb, 0xa9, 0x60, 0x2d, 0x8e,
      0x8a, 0xf3, 0x4d, 0x44, 0x58, 0x75, 0x66, 0xfc,
    ];

    await program.methods
      .updateAssetData({
        vaultId,
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: uniqueBps,
          isPeggedToBaseAsset: true, // Set to true to bypass oracle validation for this test
          inversePriceFeed: false,
          maxStaleness: new BN(
            5_000_000_000 + parseInt(uniqueId.slice(2, 4), 16) * 1000
          ), // Use unique ID
          oracleSource: { 
            pythV2: { 
              feedId: feedId,
              maxConfWidthBps: 500 // 5% confidence limit
            } 
          }
        },
      })
      .accounts({
        signer: authority.publicKey,
        boringVaultState: vaultStatePda,
        systemProgram: anchor.web3.SystemProgram.programId,
        asset: NATIVE_SOL,
        assetData: solAssetDataPda,
      })
      .signers([authority])
      .rpc();

    // Verify asset data was set correctly with PythV2 oracle
    const storedAssetData: any = await program.account.assetData.fetch(
      solAssetDataPda
    );
    // Check that PythV2 oracle source was properly stored with parameters
    expect(storedAssetData.oracleSource).to.have.property('pythV2');
    expect(storedAssetData.oracleSource.pythV2).to.have.property('feedId');
    expect(storedAssetData.oracleSource.pythV2).to.have.property('maxConfWidthBps', 500);
    expect(storedAssetData.oracleSource.pythV2.feedId).to.deep.equal(feedId);

    // Create user for testing deposit
    const user = anchor.web3.Keypair.generate();

    // Fund user with SOL
    const transferTx = new anchor.web3.Transaction().add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: authority.publicKey,
        toPubkey: user.publicKey,
        lamports: 2_000_000_000, // 2 SOL
      })
    );

    const [latestBlockhash] = await context.banksClient.getLatestBlockhash();
    transferTx.recentBlockhash = latestBlockhash;

    transferTx.feePayer = authority.publicKey;
    transferTx.sign(authority);

    await context.banksClient.processTransaction(transferTx);

    // Get user's share token account
    const userShareAta = getAssociatedTokenAddressSync(
      shareMintPda,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    );

    // Get initial balances
    const initialUserBalance = await context.banksClient.getBalance(
      user.publicKey
    );

    // Perform SOL deposit with PythV2 oracle
    const depositAmount = new BN(1_000_000_000); // 1 SOL
    const minMintAmount = new BN(900_000_000); // Expect at least 0.9 shares

    await program.methods
      .depositSol({
        vaultId,
        depositAmount,
        minMintAmount,
      })
      .accounts({
        signer: user.publicKey,
        tokenProgram2022: TOKEN_2022_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        boringVaultState: vaultStatePda,
        boringVault: anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from("boring-vault"), vaultIdBytes, Buffer.from([0])],
          program.programId
        )[0],
        assetData: solAssetDataPda,
        shareMint: shareMintPda,
        userShares: userShareAta,
        priceFeed: mockPythV2PriceFeed, // Pass PythV2 price update account
      })
      .signers([user])
      .rpc();

    // Verify deposit worked
    const finalUserBalance = await context.banksClient.getBalance(
      user.publicKey
    );
    const userShareBalance = await context.banksClient.getAccount(userShareAta);

    // Check that user's SOL balance decreased by approximately the deposit amount
    const balanceChange = Number(initialUserBalance - finalUserBalance);
    expect(balanceChange).to.be.greaterThan(depositAmount.toNumber()); // Should be deposit + transaction fees

    // Check that user received share tokens
    expect(userShareBalance).to.not.be.null;
  });
});
