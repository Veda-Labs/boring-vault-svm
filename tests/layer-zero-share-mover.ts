// @ts-nocheck

import * as anchor from "@coral-xyz/anchor";
import { BankrunProvider, startAnchor } from "anchor-bankrun";
import { ProgramTestContext, BanksClient } from "solana-bankrun";
import { expect } from "chai";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { BN } from "bn.js";
import * as fs from "fs";

// --- Constants & helpers --------------------------------------------------
// Endpoint program id – must match L0_ENDPOINT_PROGRAM_ID constant in ShareMover code
const L0_ENDPOINT_ID = new anchor.web3.PublicKey(
  "5hkWNgGVXnwofEjDNtY5u3WUCvUUxXES5wyG4V3aEo1F"
);

// Utility: minimal Token-2022 mint layout (copied from oracle-tests)
const createStubTokenMint = (
  mintAuthority: anchor.web3.PublicKey,
  decimals: number
): Buffer => {
  const buf = Buffer.alloc(82);
  buf.writeUInt32LE(1, 0); // mint_authority option = Some
  mintAuthority.toBuffer().copy(buf, 4);
  buf.writeBigUInt64LE(0n, 36); // supply = 0
  buf.writeUInt8(decimals, 44);
  buf.writeUInt8(1, 45); // is_initialized = true
  buf.writeUInt8(0, 46); // freeze_authority option = None
  return buf;
};

// Seeds
const PROGRAM_CONFIG_SEED = Buffer.from("config");
const SHARE_MOVER_SEED = Buffer.from("share_mover");
const LZ_RECEIVE_TYPES_SEED = Buffer.from("LzReceiveTypes");
const OAPP_SEED = Buffer.from("OApp");

// -------------------------------------------------------------------------
describe("layer-zero-share-mover <> endpoint integration", () => {
  let provider: BankrunProvider;
  let context: ProgramTestContext;
  let client: BanksClient;
  let smProgram: anchor.Program<any>;
  let epProgram: anchor.Program<any>;
  let admin: anchor.web3.Keypair;
  let configPda: anchor.web3.PublicKey;

  before(async () => {
    // Load compiled programs into Bankrun – endpoint mock uses constant ID.
    context = await startAnchor("", [
      {
        name: "endpoint", // matches Cargo.toml [lib] name
        programId: L0_ENDPOINT_ID,
      },
    ], []);

    provider = new BankrunProvider(context);
    client = context.banksClient;
    anchor.setProvider(provider as unknown as anchor.Provider);

    // Pull the programs directly from Anchor workspace – they now have sizes in IDL
    // thanks to the added `InitSpace` derives.
    smProgram = anchor.workspace.LayerZeroShareMover as anchor.Program<any>;
    epProgram = anchor.workspace.Endpoint as anchor.Program<any>;

    // -------------------------------------------------------------------
    // Initialize program config once
    admin = anchor.web3.Keypair.generate();
    configPda = await (async () => {
      const programKeypair = anchor.web3.Keypair.fromSecretKey(
        new Uint8Array(
          JSON.parse(
            fs.readFileSync(
              "target/deploy/layer_zero_share_mover-keypair.json",
              "utf-8"
            )
          )
        )
      );

      const [cfg] = anchor.web3.PublicKey.findProgramAddressSync(
        [PROGRAM_CONFIG_SEED],
        smProgram.programId
      );

      // fund admin
      await context.setAccount(admin.publicKey, {
        lamports: 2_000_000_000n,
        data: Buffer.alloc(0),
        owner: anchor.web3.SystemProgram.programId,
        executable: false,
        rentEpoch: 0n,
      });

      try {
        await smProgram.methods
          .initialize(admin.publicKey)
          .accounts({
            signer: admin.publicKey,
            program: programKeypair.publicKey,
            config: cfg,
            systemProgram: anchor.web3.SystemProgram.programId,
          })
          .signers([admin, programKeypair])
          .rpc();
      } catch (e) {
        if (!String(e).includes("already in use")) throw e;
      }

      return cfg;
    })();
  });

  // -----------------------------------------------------------------------
  // Helper to run initialize once
  const initializeShareMoverProgram = async (
    authority: anchor.web3.Keypair
  ) => {
    const programKeypair = anchor.web3.Keypair.fromSecretKey(
      new Uint8Array(
        JSON.parse(
          fs.readFileSync(
            "target/deploy/layer_zero_share_mover-keypair.json",
            "utf-8"
          )
        )
      )
    );

    const [configPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [PROGRAM_CONFIG_SEED],
      smProgram.programId
    );

    // Ensure authority funded
    await context.setAccount(authority.publicKey, {
      lamports: 2_000_000_000n,
      data: Buffer.alloc(0),
      owner: anchor.web3.SystemProgram.programId,
      executable: false,
      rentEpoch: 0n,
    });

    try {
      await smProgram.methods
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
      if (!String(e).includes("already in use")) throw e;
    }

    return configPda;
  };

  // -----------------------------------------------------------------------
  it("creates program config", async () => {
    const cfg: any = await smProgram.account.programConfig.fetch(configPda);
    expect(cfg.authority.toBase58()).to.equal(admin.publicKey.toBase58());
  });

  // -----------------------------------------------------------------------
  it("deploys a ShareMover and registers OApp via endpoint", async () => {
    // reuse global admin & configPda

    // --- Prepare mint ---
    const mint = anchor.web3.Keypair.generate();
    await context.setAccount(mint.publicKey, {
      lamports: 1_000_000_000n,
      data: createStubTokenMint(admin.publicKey, 9),
      owner: TOKEN_2022_PROGRAM_ID,
      executable: false,
      rentEpoch: 0n,
    });

    // Derive PDAs in advance
    const [shareMoverPda, smBump] = anchor.web3.PublicKey.findProgramAddressSync(
      [SHARE_MOVER_SEED, mint.publicKey.toBuffer()],
      smProgram.programId
    );
    const [lzTypesPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [LZ_RECEIVE_TYPES_SEED, shareMoverPda.toBuffer()],
      smProgram.programId
    );
    const [oappRegistryPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [OAPP_SEED, shareMoverPda.toBuffer()],
      L0_ENDPOINT_ID
    );

    console.log("oappRegistryPda", oappRegistryPda.toBase58());
    console.log("shareMoverPda", shareMoverPda.toBase58());
    console.log("lzTypesPda", lzTypesPda.toBase58());
    console.log("configPda", configPda.toBase58());
    console.log("mint", mint.publicKey.toBase58());

    // Call deploy
    await smProgram.methods
      .deploy({
        admin: admin.publicKey,
        executorProgram: anchor.web3.PublicKey.default,
        boringVaultProgram: anchor.web3.PublicKey.default,
        vaultId: new BN(0),
        subAccount: 0,
        peerDecimals: 9,
        outboundLimit: new BN(0),
        outboundWindow: new BN(0),
        inboundLimit: new BN(0),
        inboundWindow: new BN(0),
        peerChain: { unknown: {} },
      })
      .accounts({
        signer: admin.publicKey,
        shareMover: shareMoverPda,
        lzReceiveTypesAccounts: lzTypesPda,
        config: configPda,
        mint: mint.publicKey,
        oappRegistry: oappRegistryPda,
        endpointProgram: L0_ENDPOINT_ID,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

    // Verify ShareMover stored correctly
    const sm: any = await smProgram.account.shareMover.fetch(shareMoverPda);
    expect(sm.admin.toBase58()).to.equal(admin.publicKey.toBase58());
    expect(sm.mint.toBase58()).to.equal(mint.publicKey.toBase58());
    expect(sm.bump).to.equal(smBump);

    // Verify OAppRegistry was created in endpoint program with delegate = admin
    const registry: any = await epProgram.account.oAppRegistry.fetch(
      oappRegistryPda
    );
    expect(registry.delegate.toBase58()).to.equal(admin.publicKey.toBase58());
  });
}); 