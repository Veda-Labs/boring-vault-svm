import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { assert } from "chai";
import { BoringVaultSvm } from "../target/types/boring_vault_svm";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { AddedAccount, BanksClient, ProgramTestContext } from "solana-bankrun";
import * as fs from "fs";
import { TestHelperService as ths } from "./services/test-helpers";
import { AccountLayout } from "@solana/spl-token";

// Use WSOL as the base asset
const WSOL = new PublicKey("So11111111111111111111111111111111111111112");

describe("mint-authority", () => {
  let provider: BankrunProvider;
  let program: Program<BoringVaultSvm>;
  let context: ProgramTestContext;
  let client: BanksClient;
  let deployer: Keypair;
  let authority: Keypair;
  let newMintAuthority: Keypair;
  let user: Keypair;
  let programConfig: PublicKey;
  let vaultState: PublicKey;
  let shareMint: PublicKey;
  let userShareAta: PublicKey;
  let vaultStateBump: number;
  let shareMintBump: number;
  let vaultBaseAssetAta: PublicKey;

  // Load the program's keypair
  const boringVaultProgramKeypair = JSON.parse(
    fs.readFileSync("target/deploy/boring_vault_svm-keypair.json", "utf-8")
  );
  const boringVaultProgramSigner = Keypair.fromSecretKey(
    new Uint8Array(boringVaultProgramKeypair)
  );

  before(async () => {
    // Generate keypairs
    deployer = Keypair.generate();
    authority = Keypair.generate();
    newMintAuthority = Keypair.generate();
    user = Keypair.generate();

    // Create base accounts with lamports
    const baseAccounts: AddedAccount[] = [
      {
        address: deployer.publicKey,
        info: {
          data: Buffer.alloc(0),
          executable: false,
          lamports: LAMPORTS_PER_SOL * 10,
          owner: SystemProgram.programId,
          rentEpoch: 0,
        },
      },
      {
        address: authority.publicKey,
        info: {
          lamports: 2 * LAMPORTS_PER_SOL,
          data: Buffer.alloc(0),
          owner: SystemProgram.programId,
          executable: false,
        },
      },
      {
        address: user.publicKey,
        info: {
          lamports: 2 * LAMPORTS_PER_SOL,
          data: Buffer.alloc(0),
          owner: SystemProgram.programId,
          executable: false,
        },
      },
      {
        address: boringVaultProgramSigner.publicKey,
        info: {
          lamports: 2 * LAMPORTS_PER_SOL,
          data: fs.readFileSync("target/deploy/boring_vault_svm.so"),
          owner: new PublicKey("BPFLoader2111111111111111111111111111111111"),
          executable: true,
        },
      },
    ];

    // Set up bankrun provider with all accounts
    context = await startAnchor(
      "",
      [
        {
          name: "boring_vault_svm",
          programId: boringVaultProgramSigner.publicKey,
        },
      ],
      baseAccounts
    );
    client = context.banksClient;
    provider = new BankrunProvider(context);
    anchor.setProvider(provider);
    program = anchor.workspace.BoringVaultSvm as Program<BoringVaultSvm>;

    // Find PDAs
    [programConfig] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );

    [vaultState, vaultStateBump] = await PublicKey.findProgramAddress(
      [
        Buffer.from("boring-vault-state"),
        Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), // vault_id = 0
      ],
      program.programId
    );

    [shareMint, shareMintBump] = await PublicKey.findProgramAddress(
      [Buffer.from("share-token"), vaultState.toBuffer()],
      program.programId
    );

    // Set up token accounts
    vaultBaseAssetAta = await ths.setupATA(
      context,
      TOKEN_2022_PROGRAM_ID,
      WSOL,
      vaultState,
      0,
      true
    );

    // Set up user's share ATA
    userShareAta = await ths.setupATA(
      context,
      TOKEN_2022_PROGRAM_ID,
      shareMint,
      user.publicKey,
      0,
      false
    );

    // Initialize the program
    const initializeIx = await program.methods
      .initialize(authority.publicKey)
      .accounts({
        signer: deployer.publicKey,
        program: boringVaultProgramSigner.publicKey,
        config: programConfig,
        systemProgram: SystemProgram.programId,
      })
      .signers([deployer, boringVaultProgramSigner])
      .instruction();

    const txResult = await ths.createAndProcessTransaction(
      context.banksClient,
      deployer,
      initializeIx,
      [deployer, boringVaultProgramSigner]
    );
    await ths.expectTxToSucceed(txResult);

    // Deploy vault
    const deployIx = await program.methods
      .deploy({
        authority: authority.publicKey,
        name: "Test Vault",
        symbol: "TEST",
        exchangeRateProvider: authority.publicKey,
        exchangeRate: new anchor.BN(1000000000),
        payoutAddress: authority.publicKey,
        allowedExchangeRateChangeUpperBound: 10050,
        allowedExchangeRateChangeLowerBound: 9950,
        minimumUpdateDelayInSeconds: 3600,
        platformFeeBps: 100,
        performanceFeeBps: 2000,
        strategist: authority.publicKey,
        withdrawAuthority: PublicKey.default, // permissionless
      })
      .accounts({
        signer: authority.publicKey,
        program: program.programId,
        config: programConfig,
        boringVaultState: vaultState,
        shareMint,
        baseAsset: WSOL,
        baseAssetData: PublicKey.default,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .instruction();

    const deployTxResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      deployIx,
      [authority]
    );
    await ths.expectTxToSucceed(deployTxResult);
  });

  it("Sets a new mint authority", async () => {
    const setMintAuthIx = await program.methods
      .setMintAuthority(new anchor.BN(0), newMintAuthority.publicKey)
      .accounts({
        signer: authority.publicKey,
        boringVaultState: vaultState,
      })
      .instruction();

    const txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      setMintAuthIx,
      [authority]
    );
    await ths.expectTxToSucceed(txResult);

    const vaultStateAccount = await program.account.boringVault.fetch(vaultState);
    assert.equal(
      vaultStateAccount.config.pendingMintAuthority.toBase58(),
      newMintAuthority.publicKey.toBase58()
    );
  });

  it("Accepts the new mint authority", async () => {
    const acceptMintAuthIx = await program.methods
      .acceptMintAuthority(new anchor.BN(0))
      .accounts({
        signer: newMintAuthority.publicKey,
        boringVaultState: vaultState,
      })
      .instruction();

    const txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      acceptMintAuthIx,
      [newMintAuthority]
    );
    await ths.expectTxToSucceed(txResult);

    const vaultStateAccount = await program.account.boringVault.fetch(vaultState);
    assert.equal(
      vaultStateAccount.config.currentMintAuthority.toBase58(),
      newMintAuthority.publicKey.toBase58()
    );
    assert.equal(
      vaultStateAccount.config.pendingMintAuthority.toBase58(),
      PublicKey.default.toBase58()
    );
  });

  it("Mints shares to a user's ATA", async () => {
    const mintSharesIx = await program.methods
      .mintShares(new anchor.BN(0), new anchor.BN(1000))
      .accounts({
        signer: newMintAuthority.publicKey,
        boringVaultState: vaultState,
        shareMint: shareMint,
        ata: userShareAta,
        token_program: TOKEN_2022_PROGRAM_ID,
        token_program_2022: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    const txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      mintSharesIx,
      [newMintAuthority]
    );
    await ths.expectTxToSucceed(txResult);

    const ataAccount = await client.getAccount(userShareAta);
    assert.equal(AccountLayout.decode(ataAccount.data).amount, BigInt(1000));
  });

  it("Fails to mint shares with invalid authority", async () => {
    const invalidMintSharesIx = await program.methods
      .mintShares(new anchor.BN(0), new anchor.BN(1000))
      .accounts({
        signer: authority.publicKey,
        boringVaultState: vaultState,
        shareMint: shareMint,
        ata: userShareAta,
        token_program: TOKEN_2022_PROGRAM_ID,
        token_program_2022: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    const txResult = await ths.createAndProcessTransaction(
      client,
      deployer,
      invalidMintSharesIx,
      [authority]
    );
    await ths.expectTxToFail(txResult, "Invalid mint authority");
  });
}); 