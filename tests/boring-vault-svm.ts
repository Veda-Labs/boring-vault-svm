import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { Program } from "@coral-xyz/anchor";
import { BoringVaultSvm } from "../target/types/boring_vault_svm";
import { expect } from "chai";
import { ComputeBudgetProgram } from "@solana/web3.js";
import {
  ACCOUNT_SIZE,
  AccountLayout,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID
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

describe("boring-vault-svm", () => {
  let provider: BankrunProvider;
  let program: Program<BoringVaultSvm>;
  let context: ProgramTestContext;
  let client: BanksClient;
  let connection: Connection;

  let deployer: anchor.web3.Keypair;
  let authority: anchor.web3.Keypair = anchor.web3.Keypair.generate();
  let user: anchor.web3.Keypair = anchor.web3.Keypair.generate();

  let programConfigAccount: anchor.web3.PublicKey;
  let boringVaultAccount: anchor.web3.PublicKey;
  let boringVaultShareMint: anchor.web3.PublicKey;
  let userJitoSolAta: anchor.web3.PublicKey;
  let vaultJitoSolAta: anchor.web3.PublicKey;
  let jitoSolAssetDataPda: anchor.web3.PublicKey;
  let solAssetDataPda: anchor.web3.PublicKey;
  let userShareAta: anchor.web3.PublicKey;
  let boringVaultBankAccount: anchor.web3.PublicKey;

  let vaultWritable: anchor.web3.PublicKey;
  let vaultSigner: anchor.web3.PublicKey;
  let vaultWritableSigner: anchor.web3.PublicKey;
  let cpiDigestAccount: anchor.web3.PublicKey;
  
  const PROJECT_DIRECTORY = "";
  const SWITCHBOARD_ON_DEMAND_PROGRAM_ID = new anchor.web3.PublicKey("SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv");
  const STAKE_POOL_PROGRAM_ID = new anchor.web3.PublicKey("SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy");
  const JITO_SOL_STAKE_POOL = new anchor.web3.PublicKey("Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb");
  const JITO_SOL_STAKE_POOL_WITHDRAW_AUTH = new anchor.web3.PublicKey("6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS");
  const JITO_SOL_STAKE_POOL_RESERVE = new anchor.web3.PublicKey("BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL");
  const JITO_SOL_STAKE_POOL_FEE = new anchor.web3.PublicKey("feeeFLLsam6xZJFc6UQFrHqkvVt4jfmVvi2BRLkUZ4i");

  const JITOSOL_SOL_ORACLE = new anchor.web3.PublicKey("4Z1SLH9g4ikNBV8uP2ZctEouqjYmVqB2Tz5SZxKYBN7z");
  const JITOSOL = new anchor.web3.PublicKey("J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn");


  const ACCOUNTS_TO_CLONE = [
    JITO_SOL_STAKE_POOL.toString(),
    JITO_SOL_STAKE_POOL_WITHDRAW_AUTH.toString(),
    JITO_SOL_STAKE_POOL_RESERVE.toString(),
    JITO_SOL_STAKE_POOL_FEE.toString(),
    JITOSOL_SOL_ORACLE.toString(),
    JITOSOL.toString(),
  ];

  async function createAndProcessTransaction(
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
        units: 400_000,
      })
    );
    tx.sign(payer, ...additionalSigners);
    return await client.tryProcessTransaction(tx);
  }

  async function setupATA(
    context: ProgramTestContext,
    mintAccount: PublicKey,
    owner: PublicKey,
    amount: number
  ): Promise<PublicKey> {
    const tokenAccData = Buffer.alloc(ACCOUNT_SIZE);
    AccountLayout.encode(
      {
        mint: mintAccount,
        owner,
        amount: BigInt(amount),
        delegateOption: 0,
        delegate: PublicKey.default,
        delegatedAmount: BigInt(0),
        state: 1,
        isNativeOption: 0,
        isNative: BigInt(0),
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      tokenAccData,
    );
  
    const ata = getAssociatedTokenAddressSync(mintAccount, owner, true, TOKEN_2022_PROGRAM_ID);
    const ataAccountInfo = {
      lamports: 1_000_000_000,
      data: tokenAccData,
      owner: TOKEN_2022_PROGRAM_ID,
      executable: false,
    };
  
    context.setAccount(ata, ataAccountInfo);
    return ata;
  }

  // Helper function to get token balance from bankrun
  async function getTokenBalance(
    client: BanksClient,
    tokenAccount: PublicKey
  ): Promise<bigint> {
    const account = await client.getAccount(tokenAccount);
    if (!account) throw new Error("Account not found");

    return AccountLayout.decode(account.data).amount;
  }

  before(async () => {
    connection = new Connection("https://api.mainnet-beta.solana.com");

    // Helper function to create AddedAccount from public key
    const createAddedAccount = async (pubkeyStr: string): Promise<AddedAccount> => {
      const pubkey = new PublicKey(pubkeyStr);
      const accountInfo = await connection.getAccountInfo(pubkey);
      if (!accountInfo) throw new Error(`Failed to fetch account ${pubkeyStr}`);
      return {
        address: pubkey,
        info: accountInfo
      };
    };

    // Create base accounts for deployer, and authority.
    const baseAccounts: AddedAccount[] = [
      {
        address: authority.publicKey,
        info: {
          lamports: 2_000_000_000,
          data: Buffer.alloc(0),
          owner: anchor.web3.SystemProgram.programId,
          executable: false,
        }
      },
      {
        address: user.publicKey,
        info: {
          lamports: 2_000_000_000,
          data: Buffer.alloc(0),
          owner: anchor.web3.SystemProgram.programId,
          executable: false,
        }
      }
    ];

    const clonedAccounts = await Promise.all(
      ACCOUNTS_TO_CLONE.map(createAddedAccount)
    );

    // Combine base accounts with cloned accounts
    const allAccounts = [...baseAccounts, ...clonedAccounts];

    // Setup bankrun context
    context = await startAnchor(
      PROJECT_DIRECTORY,
      [
        {
          name: "switchboard_on_demand",
          programId: SWITCHBOARD_ON_DEMAND_PROGRAM_ID
        },
        {
          name: "sol_stake_pool",
          programId: STAKE_POOL_PROGRAM_ID
        }
      ],
      allAccounts
    );
    client = context.banksClient;
    provider = new BankrunProvider(context);
    deployer = context.payer;
    anchor.setProvider(provider);

    program = anchor.workspace.BoringVaultSvm as Program<BoringVaultSvm>;

    // Find PDAs
    let bump;
    [programConfigAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("config")
      ],
      program.programId
    );

    [boringVaultAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-vault"),
        Buffer.from(new Array(8).fill(0))
      ],
      program.programId
    );

    [boringVaultBankAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("boring-vault-bank"),
        Buffer.from(new Array(8).fill(0))
      ],
      program.programId
    );
    
    [boringVaultShareMint, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("share-token"),
        boringVaultAccount.toBuffer(),
      ],
      program.programId
    );

    [jitoSolAssetDataPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("asset-data"),
        boringVaultAccount.toBuffer(),
        JITOSOL.toBuffer(),
      ],
      program.programId
    );

    [solAssetDataPda, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("asset-data"),
        boringVaultAccount.toBuffer(),
        anchor.web3.PublicKey.default.toBuffer(),
      ],
      program.programId
    );

    [vaultWritable, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault-writable"),
      ],
      program.programId
    );

    [vaultSigner, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault-signer"),
      ],
      program.programId
    );

    [vaultWritableSigner, bump] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault-writable-signer"),
      ],
      program.programId
    );

    userJitoSolAta = await setupATA(context, JITOSOL, user.publicKey, 1000000000000000000);
    vaultJitoSolAta = await setupATA(context, JITOSOL, boringVaultAccount, 0);
    userShareAta = await setupATA(context, boringVaultShareMint, user.publicKey, 0);
  });

  it("Is initialized", async () => {
    const ix = await program.methods
    .initialize(
      authority.publicKey
    )
    .accounts({
      // @ts-ignore
      config: programConfigAccount,
      signer: deployer.publicKey,
    })
    .instruction();

    let txResult = await createAndProcessTransaction(client, deployer, ix, [deployer]);

    // Expect the tx to succeed.
    expect(txResult.result).to.be.null;

    const programConfig = await program.account.programConfig.fetch(programConfigAccount);
    expect(programConfig.authority.equals(authority.publicKey)).to.be.true;
    expect(programConfig.vaultCount.toNumber()).to.equal(0);
  });

  it("Can deploy a vault", async () => {
    const ix = await program.methods
    .deploy(
      {
        authority: authority.publicKey,
        strategist: user.publicKey,
        name: "Boring Vault",
        symbol: "Boring Vault",
        decimals: 9
      }
    )
    .accounts({
      // @ts-ignore
      config: programConfigAccount,
      boringVault: boringVaultAccount,
      shareMint: boringVaultShareMint,
      signer: authority.publicKey,
      systemProgram: anchor.web3.SystemProgram.programId,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .instruction();

    let txResult = await createAndProcessTransaction(client, deployer, ix, [authority]);

    // Expect the tx to succeed.
    expect(txResult.result).to.be.null;

    const programConfig = await program.account.programConfig.fetch(programConfigAccount);
    expect(programConfig.vaultCount.toNumber()).to.equal(1);

    const boringVault = await program.account.boringVault.fetch(boringVaultAccount);
    expect(boringVault.config.vaultId.toNumber()).to.equal(0);
    expect(boringVault.config.authority.equals(authority.publicKey)).to.be.true;
    expect(boringVault.config.shareMint.equals(boringVaultShareMint)).to.be.true;
    expect(boringVault.config.paused).to.be.false;
    expect(boringVault.config.initialized).to.be.true;

  });

  it("Can update asset data", async () => {
    const ix = await program.methods
    .updateAssetData(
      {
        vaultId: new anchor.BN(0),
        assetData: {
          decimals: 9,
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 100,
          priceFeed: JITOSOL_SOL_ORACLE,
          inversePriceFeed: false,
        }
      }
    )
    .accounts({
      signer: authority.publicKey,
      boringVault: boringVaultAccount,
      // @ts-ignore
      systemProgram: anchor.web3.SystemProgram.programId,
      asset: JITOSOL,
      assetData: jitoSolAssetDataPda,
    })
    .instruction();

    let txResult = await createAndProcessTransaction(client, deployer, ix, [authority]);

    // Expect the tx to succeed.
    expect(txResult.result).to.be.null;

    const assetData = await program.account.assetData.fetch(jitoSolAssetDataPda);
    expect(assetData.decimals).to.equal(9);
    expect(assetData.allowDeposits).to.be.true;
    expect(assetData.allowWithdrawals).to.be.true;
    expect(assetData.sharePremiumBps).to.equal(100);
    expect(assetData.priceFeed.equals(JITOSOL_SOL_ORACLE)).to.be.true;
    expect(assetData.inversePriceFeed).to.be.false;
  });

  it("Can deposit SOL into a vault", async () => {
    const ix_0 = await program.methods
    .updateAssetData(
      {
        vaultId: new anchor.BN(0),
        assetData: {
          decimals: 9,
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 0,
          priceFeed: JITOSOL_SOL_ORACLE,
          inversePriceFeed: true,
        }
      }
    )
    .accounts({
      signer: authority.publicKey,
      boringVault: boringVaultAccount,
      // @ts-ignore
      systemProgram: anchor.web3.SystemProgram.programId,
      asset: anchor.web3.PublicKey.default,
      assetData: solAssetDataPda,
    })
    .instruction();

    let txResult_0 = await createAndProcessTransaction(client, deployer, ix_0, [authority]);

    // Expect the tx to succeed.
    expect(txResult_0.result).to.be.null;

    const ix_1 = await program.methods
    .deposit(
      {
        vaultId: new anchor.BN(0),
        depositAmount: new anchor.BN(1000000000),
        minMintAmount: new anchor.BN(0),
      }
    )
    .accounts({
      // @ts-ignore
      signer: user.publicKey,
      boringVault: boringVaultAccount,
      depositMint: null,
      // @ts-ignore
      userAta: null,
      vaultAta: null,
      // @ts-ignore
      assetData: solAssetDataPda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      shareMint: boringVaultShareMint,
      userShares: userShareAta,
      priceFeed: JITOSOL_SOL_ORACLE,
    })
    .instruction();

    let txResult_1 = await createAndProcessTransaction(client, deployer, ix_1, [user]);

    // Expect the tx to succeed.
    expect(txResult_1.result).to.be.null;

    const userShareBalance = await getTokenBalance(client, userShareAta);
    expect(userShareBalance.toString()).to.equal("1000000000");
  });
  
  it("Can deposit JitoSOL into a vault", async () => {
    const ix_0 = await program.methods
    .updateAssetData(
      {
        vaultId: new anchor.BN(0),
        assetData: {
          decimals: 9,
          allowDeposits: true,
          allowWithdrawals: true,
          sharePremiumBps: 0,
          priceFeed: JITOSOL_SOL_ORACLE,
          inversePriceFeed: false,
        }
      }
    )
    .accounts({
      signer: authority.publicKey,
      boringVault: boringVaultAccount,
      // @ts-ignore
      systemProgram: anchor.web3.SystemProgram.programId,
      asset: JITOSOL,
      assetData: jitoSolAssetDataPda,
    })
    .instruction();

    let txResult_0 = await createAndProcessTransaction(client, deployer, ix_0, [authority]);

    // Expect the tx to succeed.
    expect(txResult_0.result).to.be.null;

    const ix_1 = await program.methods
    .deposit(
      {
        vaultId: new anchor.BN(0),
        depositAmount: new anchor.BN(1000000000),
        minMintAmount: new anchor.BN(0),
      }
    )
    .accounts({
      // @ts-ignore
      signer: user.publicKey,
      boringVault: boringVaultAccount,
      depositMint: JITOSOL,
      // @ts-ignore
      assetData: jitoSolAssetDataPda,
      userAta: userJitoSolAta,
      vaultAta: vaultJitoSolAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      shareMint: boringVaultShareMint,
      userShares: userShareAta,
      priceFeed: JITOSOL_SOL_ORACLE,
    })
    .instruction();

    let txResult_1 = await createAndProcessTransaction(client, deployer, ix_1, [user]);

    // Expect the tx to succeed.
    expect(txResult_1.result).to.be.null;

    // We expect this to be 1 share larger because of the previous deposit.
    const userShareBalance = await getTokenBalance(client, userShareAta);
    expect(userShareBalance.toString()).to.equal("2171923747");
  });

  it("Vault can transfer sol to recipient", async () => {
    // Transfer SOL from user to vault.
    const ix_0 = await program.methods
    .depositToBank(
      {
        vaultId: new anchor.BN(0),
        amount: new anchor.BN(100000000),
      }
    )
    .accounts({
      signer: authority.publicKey,
      boringVaultBank: boringVaultBankAccount,
      // @ts-ignore
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .instruction();

    let txResult_0 = await createAndProcessTransaction(client, deployer, ix_0, [authority]);

    console.log(txResult_0.result);

    expect(txResult_0.result).to.be.null;

    // Transfer sol from vault to user.
    const ix_1 = await program.methods
    .transferSol(
      {
        vaultId: new anchor.BN(0),
        amount: new anchor.BN(100000000),
      }
    )
    .accounts({
      signer: authority.publicKey,
      boringVaultBank: boringVaultBankAccount,
      // @ts-ignore
      systemProgram: anchor.web3.SystemProgram.programId,
    })
    .remainingAccounts([
      {
        pubkey: boringVaultBankAccount,
        isWritable: true,
        isSigner: false
      },
      {
        pubkey: user.publicKey,
        isWritable: true,
        isSigner: false,
      }
    ])
    .instruction();

    let txResult_1 = await createAndProcessTransaction(client, deployer, ix_1, [authority]);

    console.log(txResult_1.result);

    expect(txResult_1.result).to.be.null;
  });

  // it("Vault can deposit SOL into JitoSOL stake pool", async () => {

  //   // Transfer SOL from user to vault.
  //   const transferIx = anchor.web3.SystemProgram.transfer({
  //     fromPubkey: user.publicKey,
  //     toPubkey: boringVaultAccount,
  //     lamports: 100_000_000, // 0.1 SOL
  //   });
  
  // let transferTxResult = await createAndProcessTransaction(
  //     client, 
  //     user,  // user needs to sign since they're sending SOL
  //     transferIx
  //   );

  //   // Expect the tx to succeed.
  //   expect(transferTxResult.result).to.be.null;

  //   // Preview the cpi digest.
  //   const view_ix = await program.methods
  //   .viewCpiDigest(
  //     {
  //         vaultId: new anchor.BN(0),
  //         ixProgramId: STAKE_POOL_PROGRAM_ID,
  //         ixData: Buffer.from("0e40420f0000000000", "hex"),
  //         operators: {
  //           operators: [],
  //         },
  //         expectedSize: 32,
  //     }
  //   )
  //   .accounts({
  //     signer: deployer.publicKey,
  //     boringVault: boringVaultAccount,
  //   })
  //   .remainingAccounts([
  //     {
  //       pubkey: JITO_SOL_STAKE_POOL,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: JITO_SOL_STAKE_POOL_WITHDRAW_AUTH,
  //       isWritable: false,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: JITO_SOL_STAKE_POOL_RESERVE,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: boringVaultAccount,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: vaultJitoSolAta,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: JITO_SOL_STAKE_POOL_FEE,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: vaultJitoSolAta,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: JITOSOL,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: anchor.web3.SystemProgram.programId,
  //       isWritable: false,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: TOKEN_2022_PROGRAM_ID,
  //       isWritable: false,
  //       isSigner: false
  //     }
  //   ])
  //   .instruction();

  //   let txResult = await createAndProcessTransaction(client, deployer, view_ix, [deployer]);

  //   // Expect the tx to succeed.
  //   expect(txResult.result).to.be.null;

  //   let digest = [86, 220, 10, 71, 218, 33, 183, 2, 80, 116, 105, 213, 99, 54, 90, 28, 101, 127, 111, 7, 64, 51, 74, 254, 42, 21, 39, 52, 179, 124, 251, 121];
    
  //   let bump;
  //   [cpiDigestAccount, bump] = anchor.web3.PublicKey.findProgramAddressSync(
  //     [
  //       Buffer.from("cpi-digest"),
  //       boringVaultAccount.toBuffer(),
  //       Buffer.from(digest),
  //     ],
  //     program.programId
  //   );

  //   const ix_0 = await program.methods.updateCpiDigest(
  //     {
  //       vaultId: new anchor.BN(0),
  //       cpiDigest: digest,
  //       isValid: true,
  //     }
  //   )
  //   .accounts({
  //     signer: authority.publicKey,
  //     boringVault: boringVaultAccount,
  //     // @ts-ignore
  //     systemProgram: anchor.web3.SystemProgram.programId,
  //     cpiDigest: cpiDigestAccount,
  //   })
  //   .instruction();

  //   let txResult_0 = await createAndProcessTransaction(client, deployer, ix_0, [authority]);

  //   // Expect the tx to succeed.
  //   expect(txResult_0.result).to.be.null;
    
  //   console.log("ix: ", Buffer.from("0e40420f0000000000", "hex"));

  //   const ix_1 = await program.methods
  //   .manage(
  //       {
  //         vaultId: new anchor.BN(0),
  //         ixProgramId: STAKE_POOL_PROGRAM_ID,
  //         ixData: Buffer.from("0e40420f0000000000", "hex"),
  //         operators: {
  //           operators: [],
  //         },
  //         expectedSize: 32,
  //     }
  //   )
  //   .accounts({
  //     signer: authority.publicKey,
  //     boringVault: boringVaultAccount,
  //     cpiDigest: cpiDigestAccount,
  //   })
  //   .remainingAccounts([
  //     {
  //       pubkey: JITO_SOL_STAKE_POOL,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: JITO_SOL_STAKE_POOL_WITHDRAW_AUTH,
  //       isWritable: false,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: JITO_SOL_STAKE_POOL_RESERVE,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: boringVaultAccount,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: vaultJitoSolAta,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: JITO_SOL_STAKE_POOL_FEE,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: vaultJitoSolAta,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: JITOSOL,
  //       isWritable: true,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: anchor.web3.SystemProgram.programId,
  //       isWritable: false,
  //       isSigner: false
  //     },
  //     {
  //       pubkey: TOKEN_2022_PROGRAM_ID,
  //       isWritable: false,
  //       isSigner: false
  //     }
  //   ])
  //   .instruction();

  //   let txResult_1 = await createAndProcessTransaction(client, deployer, ix_1, [authority]);

  //   // Expect the tx to succeed.
  //   expect(txResult_1.result).to.be.null;
  // });
});

