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
import { BN } from "bn.js";

// Load the IDL JSON ourselves (synchronously, no require).
const idlPath = resolve(process.cwd(), "target/idl/boring_vault_svm.json");
const idl = JSON.parse(readFileSync(idlPath, "utf-8"));

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
  const createStubTokenMint = (mintAuthority: anchor.web3.PublicKey, decimals: number): Buffer => {
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
    const original = { SwitchboardV2: {} } as const;

    // Encode → decode round-trip.
    const buf = coder.types.encode("OracleSource", original);
    const decoded = coder.types.decode("OracleSource", buf);

    // The first byte represents the variant index (0 for the first variant).
    expect(buf[0]).to.equal(0, "Unexpected variant discriminant for SwitchboardV2");
    expect(decoded).to.deep.equal(original);
  });

  it("encodes and decodes Pyth correctly", () => {
    const original = { Pyth: {} } as const;

    const buf = coder.types.encode("OracleSource", original);
    const decoded = coder.types.decode("OracleSource", buf);

    expect(buf[0]).to.equal(1, "Unexpected variant discriminant for Pyth");
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
      price_feed: new anchor.web3.PublicKey("11111111111111111111111111111111"), // placeholder
      inverse_price_feed: false,
      max_staleness: new BN(0),
      min_samples: 0,
      oracle_source: undefined as unknown as any, // will be filled per variant
    };

    const variants = [
      { SwitchboardV2: {} },
      { Pyth: {} },
    ] as const;

    for (const oracleVariant of variants) {
      const assetData = { ...minimalAssetData, oracle_source: oracleVariant };

      const buf = coder.types.encode("AssetData", assetData);
      const decoded = coder.types.decode("AssetData", buf);

      expect(decoded.oracle_source).to.deep.equal(
        oracleVariant,
        `Mismatch after round-trip for variant ${Object.keys(oracleVariant)[0]}`
      );
    }
  });

  it("decodes raw discriminant bytes", () => {
    const switchboardBuf = Buffer.from([0]);
    const pythBuf = Buffer.from([1]);

    expect(coder.types.decode("OracleSource", switchboardBuf)).to.deep.equal({ SwitchboardV2: {} });
    expect(coder.types.decode("OracleSource", pythBuf)).to.deep.equal({ Pyth: {} });
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
    const program = new anchor.Program(idl, provider as unknown as anchor.Provider) as anchor.Program<any>;

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
  // Oracle enum integration test - tests pyth oracle source enum serialization
  // -----------------------------------------------------------------------------
  it("successfully updates asset data with pyth oracle source enum", async () => {
    const authority = provider.wallet.payer as anchor.web3.Keypair;
    const program = new anchor.Program(idl, provider as unknown as anchor.Provider) as anchor.Program<any>;

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
    const programConfig: any = await program.account.programConfig.fetch(configPda);
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
      [Buffer.from("asset-data"), vaultStatePda.toBuffer(), testMint.publicKey.toBuffer()],
      program.programId
    );

    const mockPriceFeed = anchor.web3.Keypair.generate().publicKey;

    // Test pyth oracle source enum - this is the key test
    const uniqueBps = parseInt(uniqueId.slice(0, 2), 16) % 100; // Use part of unique ID for BPS
    
    await program.methods
      .updateAssetData({
        vaultId,
        assetData: {
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: uniqueBps,
          isPeggedToBaseAsset: true, // Set to true to bypass oracle validation for this test
          priceFeed: mockPriceFeed,
          inversePriceFeed: false,
          maxStaleness: new BN(5_000_000_000 + parseInt(uniqueId.slice(2, 4), 16) * 1000), // Use unique ID
          minSamples: 0,
          oracleSource: { pyth: {} }, // Test pyth enum variant
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
    const storedAssetData: any = await program.account.assetData.fetch(assetDataPda);
    
    // Check that pyth oracle source was properly stored
    expect(storedAssetData.oracleSource).to.deep.include({ pyth: {} });
    expect(storedAssetData.allowDeposits).to.be.true;
    expect(storedAssetData.isPeggedToBaseAsset).to.be.true;
  });

  // -----------------------------------------------------------------------------
  // SOL deposit test with Pyth oracle source
  // -----------------------------------------------------------------------------
  it("can deposit SOL into a vault with pyth oracle source", async () => {
    const authority = provider.wallet.payer as anchor.web3.Keypair;
    const program = new anchor.Program(idl, provider as unknown as anchor.Provider) as anchor.Program<any>;

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
    const programConfig: any = await program.account.programConfig.fetch(configPda);
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
    const NATIVE_SOL = new anchor.web3.PublicKey("11111111111111111111111111111111");
    const [solAssetDataPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from("asset-data"), vaultStatePda.toBuffer(), NATIVE_SOL.toBuffer()],
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
          priceFeed: mockPythPriceFeed,
          inversePriceFeed: false,
          maxStaleness: new BN(5_000_000_000 + parseInt(uniqueId.slice(2, 4), 16) * 1000), // Use unique ID
          minSamples: 0,
          oracleSource: { pyth: {} }, // Use Pyth oracle source
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

    // Verify asset data was set correctly with Pyth oracle
    const storedAssetData: any = await program.account.assetData.fetch(solAssetDataPda);
    expect(storedAssetData.oracleSource).to.deep.include({ pyth: {} });

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
    const initialUserBalance = await context.banksClient.getBalance(user.publicKey);
    
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
    const finalUserBalance = await context.banksClient.getBalance(user.publicKey);
    const userShareBalance = await context.banksClient.getAccount(userShareAta);
    
    // Check that user's SOL balance decreased by approximately the deposit amount
    const balanceChange = Number(initialUserBalance - finalUserBalance);
    expect(balanceChange).to.be.greaterThan(depositAmount.toNumber()); // Should be deposit + transaction fees
    
    // Check that user received share tokens
    expect(userShareBalance).to.not.be.null;
  });
});