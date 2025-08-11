import { PublicKey } from "@solana/web3.js";

// Reusable big-endian u32 helper ----------------------------------------------------------------
function u32ToBeBytes(n: number): Uint8Array {
  const arr = new Uint8Array(4);
  new DataView(arr.buffer).setUint32(0, n, false /* big-endian */);
  return arr;
}

// Parameters required to derive all PDAs used by the send script.
export interface PdaArgs {
  dstEid: number;
  shareMint: PublicKey;
  vaultId: bigint;
  receiverBuf: Buffer; // 32-byte padded recipient

  // Program IDs -------------------------------------------------------------
  shareMoverProgramId: PublicKey;
  endpointProgramId: PublicKey;
  boringVaultProgramId: PublicKey;
  sendLibraryProgramId: PublicKey;
  dvnProgramId: PublicKey;

  // Message-library chosen for sending (ULN or SimpleMessageLib)
  chosenLib: PublicKey;
}

export interface Pdas {
  shareMover: PublicKey;
  peer: PublicKey;
  endpointSettings: PublicKey;
  nonce: PublicKey;
  eventAuthority: PublicKey;
  eventAuthorityForUNLSend: PublicKey;
  oappRegistry: PublicKey;
  payloadHash: PublicKey;
  sendLibraryConfig: PublicKey;
  defaultSendLibraryConfig: PublicKey;
  sendLibraryInfo: PublicKey;
  vault: PublicKey;
  shareMintPda: PublicKey;
  executorConfig: PublicKey;
  dvnConfig: PublicKey;
  uln: PublicKey;
  sendConfig: PublicKey;
  defaultSendConfig: PublicKey;
}

// ---------------------------------------------------------------------------
// Main derivation entry point
// ---------------------------------------------------------------------------

export function derivePdas(a: PdaArgs): Pdas {
  // -------------------------------------------------------------------------
  // ShareMover & peer-related PDAs (LayerZeroShareMover program)
  // -------------------------------------------------------------------------
  const shareMoverSeed = Buffer.from("share_mover");
  const [shareMover] = PublicKey.findProgramAddressSync(
    [shareMoverSeed, a.shareMint.toBuffer()],
    a.shareMoverProgramId
  );

  const dstEidBe = u32ToBeBytes(a.dstEid);

  const peerSeed = Buffer.from("Peer");
  const [peer] = PublicKey.findProgramAddressSync(
    [peerSeed, shareMover.toBuffer(), dstEidBe],
    a.shareMoverProgramId
  );

  // -------------------------------------------------------------------------
  // Endpoint-program PDAs
  // -------------------------------------------------------------------------
  const endpointSeed = Buffer.from("Endpoint");
  const [endpointSettings] = PublicKey.findProgramAddressSync(
    [endpointSeed],
    a.endpointProgramId
  );

  const nonceSeed = Buffer.from("Nonce");
  const [nonce] = PublicKey.findProgramAddressSync(
    [nonceSeed, shareMover.toBuffer(), dstEidBe, a.receiverBuf],
    a.endpointProgramId
  );

  const eventSeed = Buffer.from("__event_authority");
  const [eventAuthority] = PublicKey.findProgramAddressSync([
    eventSeed,
  ], a.endpointProgramId);
  const [eventAuthorityForUNLSend] = PublicKey.findProgramAddressSync([
    eventSeed,
  ], a.sendLibraryProgramId);

  const oappSeed = Buffer.from("OApp");
  const [oappRegistry] = PublicKey.findProgramAddressSync(
    [oappSeed, shareMover.toBuffer()],
    a.endpointProgramId
  );

  const phSeed = Buffer.from("PayloadHash");
  const zeroNonceBuf = Buffer.alloc(8);
  const [payloadHash] = PublicKey.findProgramAddressSync(
    [phSeed, shareMover.toBuffer(), dstEidBe, a.receiverBuf, zeroNonceBuf],
    a.endpointProgramId
  );

  // -------------------------------------------------------------------------
  // Send-library configuration PDAs (Endpoint program)
  // -------------------------------------------------------------------------
  const sendLibConfigSeed = Buffer.from("SendLibraryConfig");
  const [sendLibraryConfig] = PublicKey.findProgramAddressSync(
    [sendLibConfigSeed, shareMover.toBuffer(), dstEidBe],
    a.endpointProgramId
  );
  const [defaultSendLibraryConfig] = PublicKey.findProgramAddressSync(
    [sendLibConfigSeed, dstEidBe],
    a.endpointProgramId
  );

  const msgLibSeed = Buffer.from("MessageLib");
  const [sendLibraryInfo] = PublicKey.findProgramAddressSync(
    [msgLibSeed, a.chosenLib.toBytes()],
    a.endpointProgramId
  );

  // -------------------------------------------------------------------------
  // Boring-Vault PDAs
  // -------------------------------------------------------------------------
  const vaultStateSeed = Buffer.from("boring-vault-state");
  const vaultIdBuf = Buffer.alloc(8);
  vaultIdBuf.writeBigUInt64LE(a.vaultId);
  const [vault] = PublicKey.findProgramAddressSync(
    [vaultStateSeed, vaultIdBuf],
    a.boringVaultProgramId
  );

  const shareTokenSeed = Buffer.from("share-token");
  const [shareMintPda] = PublicKey.findProgramAddressSync(
    [shareTokenSeed, vault.toBuffer()],
    a.boringVaultProgramId
  );

  // -------------------------------------------------------------------------
  // Executor / DVN / ULN configs (send-library + dvn programs)
  // -------------------------------------------------------------------------
  const EXECUTOR_CFG_SEED = Buffer.from("ExecutorConfig");
  const [executorConfig] = PublicKey.findProgramAddressSync(
    [EXECUTOR_CFG_SEED],
    a.sendLibraryProgramId
  );

  const DVN_CFG_SEED = Buffer.from("DvnConfig");
  const [dvnConfig] = PublicKey.findProgramAddressSync(
    [DVN_CFG_SEED, dstEidBe],
    a.dvnProgramId
  );

  const ULN_SEED = Buffer.from("MessageLib");
  const [uln] = PublicKey.findProgramAddressSync([
    ULN_SEED,
  ], a.sendLibraryProgramId);

  const SEND_CFG_SEED = Buffer.from("SendConfig");
  const [sendConfig] = PublicKey.findProgramAddressSync([
    SEND_CFG_SEED,
    dstEidBe,
    shareMover.toBuffer(),
  ], a.chosenLib);
  const [defaultSendConfig] = PublicKey.findProgramAddressSync([
    SEND_CFG_SEED,
    dstEidBe,
  ], a.chosenLib);

  return {
    shareMover,
    peer,
    endpointSettings,
    nonce,
    eventAuthority,
    eventAuthorityForUNLSend,
    oappRegistry,
    payloadHash,
    sendLibraryConfig,
    defaultSendLibraryConfig,
    sendLibraryInfo,
    vault,
    shareMintPda,
    executorConfig,
    dvnConfig,
    uln,
    sendConfig,
    defaultSendConfig,
  } as const;
}
