// A minimal Bitcoin SV anchor: one P2PKH input, one OP_FALSE OP_RETURN data
// output, one change output. Node's crypto only (secp256k1 ECDSA, SHA-256,
// RIPEMD-160); no wallet library, no keys on disk.
//
// The data output is: OP_FALSE OP_RETURN "jevb.qa" 0x01 <32-byte hash>
// [<prompt text>, only with publishPrompt]. Everything onchain is public and
// permanent, so by default it holds a hash and nothing readable.
//
// Nothing here broadcasts unless anchor() gets broadcast: true AND a WIF key.
// The default is a dry run: the same transaction is built and signed with a
// throwaway in-memory key spending a made-up outpoint, so every byte of the
// format is exercised and verify() can check it, but it is not valid on any
// chain and is never sent.
import crypto from 'node:crypto'

export const TAG = 'jevb.qa'
export const FORMAT_VERSION = 1
const SIGHASH_ALL_FORKID = 0x41
const N = BigInt('0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141')
const API = () => process.env.JEVB_BSV_API || 'https://api.whatsonchain.com/v1/bsv/main'
// Satoshis per 1000 bytes. Miners on BSV take well under this; it errs high.
const FEE_PER_KB = () => Number(process.env.JEVB_BSV_FEE_PER_KB || 500)

export const sha256 = (b) => crypto.createHash('sha256').update(b).digest()
const dsha = (b) => sha256(sha256(b))
const hash160 = (b) => crypto.createHash('ripemd160').update(sha256(b)).digest()

// ---- encoding ------------------------------------------------------------

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b }
export function varint(n) {
    if (n < 0xfd) return Buffer.from([n])
    if (n <= 0xffff) { const b = Buffer.alloc(3); b[0] = 0xfd; b.writeUInt16LE(n, 1); return b }
    const b = Buffer.alloc(5); b[0] = 0xfe; b.writeUInt32LE(n, 1); return b
}
export function pushData(data) {
    const n = data.length
    if (n < 0x4c) return Buffer.concat([Buffer.from([n]), data])
    if (n <= 0xff) return Buffer.concat([Buffer.from([0x4c, n]), data])
    if (n <= 0xffff) { const l = Buffer.alloc(2); l.writeUInt16LE(n); return Buffer.concat([Buffer.from([0x4d]), l, data]) }
    const l = Buffer.alloc(4); l.writeUInt32LE(n); return Buffer.concat([Buffer.from([0x4e]), l, data])
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
export function base58check(payload) {
    const data = Buffer.concat([payload, dsha(payload).subarray(0, 4)])
    let n = BigInt('0x' + (data.toString('hex') || '0'))
    let out = ''
    while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n }
    for (const byte of data) { if (byte) break; out = '1' + out }
    return out
}
export function fromBase58check(s) {
    let n = 0n
    for (const c of s) {
        const i = B58.indexOf(c)
        if (i < 0) throw new Error('not base58')
        n = n * 58n + BigInt(i)
    }
    let hex = n.toString(16); if (hex.length % 2) hex = '0' + hex
    const zeros = s.match(/^1*/)[0].length
    const data = Buffer.concat([Buffer.alloc(zeros), Buffer.from(n ? hex : '', 'hex')])
    const payload = data.subarray(0, -4)
    if (!dsha(payload).subarray(0, 4).equals(data.subarray(-4))) throw new Error('bad base58 checksum')
    return payload
}

// ---- keys ----------------------------------------------------------------

const b64u = (b) => Buffer.from(b).toString('base64url')

// A private key from 32 raw bytes: Node KeyObject, compressed pubkey, address.
export function keyFromSecret(d) {
    const ecdh = crypto.createECDH('secp256k1')
    ecdh.setPrivateKey(d)
    const pub = ecdh.getPublicKey()
    const privateKey = crypto.createPrivateKey({ key: { kty: 'EC', crv: 'secp256k1', d: b64u(d), x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: 'jwk' })
    const compressed = Buffer.from(ecdh.getPublicKey(null, 'compressed'))
    const pkh = hash160(compressed)
    return { privateKey, publicKey: compressed, pkh, address: base58check(Buffer.concat([Buffer.from([0x00]), pkh])) }
}

export function keyFromWif(wif) {
    const p = fromBase58check(wif.trim())
    if (p[0] !== 0x80 || !(p.length === 33 || (p.length === 34 && p[33] === 1))) throw new Error('JEVB_BSV_WIF is not a mainnet WIF private key')
    if (p.length === 33) throw new Error('uncompressed WIF keys are not supported')
    return keyFromSecret(p.subarray(1, 33))
}

export const p2pkh = (pkh) => Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), pkh, Buffer.from([0x88, 0xac])])

// ---- transactions --------------------------------------------------------

export function dataScript(hash, { prompt } = {}) {
    if (hash.length !== 32) throw new Error('anchor hash must be 32 bytes')
    const parts = [Buffer.from([0x00, 0x6a]), pushData(Buffer.from(TAG)), pushData(Buffer.from([FORMAT_VERSION])), pushData(hash)]
    if (prompt != null) parts.push(pushData(Buffer.from(prompt, 'utf8')))
    return Buffer.concat(parts)
}

export function serialize(tx) {
    return Buffer.concat([
        u32(tx.version), varint(tx.inputs.length),
        ...tx.inputs.flatMap((i) => [Buffer.from(i.txid, 'hex').reverse(), u32(i.vout), varint(i.script.length), i.script, u32(i.sequence)]),
        varint(tx.outputs.length),
        ...tx.outputs.flatMap((o) => [u64(o.value), varint(o.script.length), o.script]),
        u32(tx.locktime),
    ])
}

export const txid = (raw) => Buffer.from(dsha(raw)).reverse().toString('hex')

// BIP143-style digest with FORKID, which BSV requires.
export function sighash(tx, index, prevScript, prevValue, type = SIGHASH_ALL_FORKID) {
    const prevouts = dsha(Buffer.concat(tx.inputs.map((i) => Buffer.concat([Buffer.from(i.txid, 'hex').reverse(), u32(i.vout)]))))
    const sequences = dsha(Buffer.concat(tx.inputs.map((i) => u32(i.sequence))))
    const outputs = dsha(Buffer.concat(tx.outputs.map((o) => Buffer.concat([u64(o.value), varint(o.script.length), o.script]))))
    const inp = tx.inputs[index]
    return Buffer.concat([
        u32(tx.version), prevouts, sequences,
        Buffer.from(inp.txid, 'hex').reverse(), u32(inp.vout),
        varint(prevScript.length), prevScript, u64(prevValue), u32(inp.sequence),
        outputs, u32(tx.locktime), u32(type),
    ])
}

// DER signature with s forced low (s <= n/2), as nodes require.
function lowS(der) {
    const rLen = der[3], r = der.subarray(4, 4 + rLen)
    const sLen = der[5 + rLen], sBuf = der.subarray(6 + rLen, 6 + rLen + sLen)
    let s = BigInt('0x' + sBuf.toString('hex'))
    if (s <= N / 2n) return der
    s = N - s
    let hex = s.toString(16); if (hex.length % 2) hex = '0' + hex
    let sb = Buffer.from(hex, 'hex'); if (sb[0] & 0x80) sb = Buffer.concat([Buffer.from([0]), sb])
    const body = Buffer.concat([Buffer.from([0x02, rLen]), r, Buffer.from([0x02, sb.length]), sb])
    return Buffer.concat([Buffer.from([0x30, body.length]), body])
}

// The signature is over dsha(preimage): crypto.sign('sha256', sha256(p))
// computes ECDSA over sha256(sha256(p)).
export function signInput(tx, index, key, prevValue) {
    const preimage = sighash(tx, index, p2pkh(key.pkh), prevValue)
    const der = lowS(crypto.sign('sha256', sha256(preimage), key.privateKey))
    tx.inputs[index].script = Buffer.concat([pushData(Buffer.concat([der, Buffer.from([SIGHASH_ALL_FORKID])])), pushData(key.publicKey)])
    return { preimage, der }
}

// utxo: { txid, vout, value } locked to key's address.
export function buildAnchorTx({ hash, prompt, key, utxo, feePerKb = FEE_PER_KB() }) {
    const tx = { version: 1, locktime: 0, inputs: [{ txid: utxo.txid, vout: utxo.vout, script: Buffer.alloc(0), sequence: 0xffffffff }], outputs: [{ value: 0, script: dataScript(hash, { prompt }) }] }
    tx.outputs.push({ value: 0, script: p2pkh(key.pkh) })
    // Size with a placeholder signature (max length) to price the fee.
    tx.inputs[0].script = Buffer.alloc(1 + 73 + 1 + 33)
    const fee = Math.max(1, Math.ceil(serialize(tx).length * feePerKb / 1000))
    const change = utxo.value - fee
    if (change < 1) throw new Error(`the funding output (${utxo.value} sat) doesn't cover the ${fee} sat fee`)
    // Dust: a 1-sat change output is fine on BSV.
    tx.outputs[1].value = change
    signInput(tx, 0, key, utxo.value)
    const raw = serialize(tx)
    return { tx, raw, txid: txid(raw), fee, change }
}

// ---- parsing (verify side) -----------------------------------------------

export function parseTx(raw) {
    let o = 0
    const take = (n) => { if (o + n > raw.length) throw new Error('truncated transaction'); const b = raw.subarray(o, o + n); o += n; return b }
    const vi = () => {
        const f = take(1)[0]
        if (f < 0xfd) return f
        if (f === 0xfd) return take(2).readUInt16LE()
        if (f === 0xfe) return take(4).readUInt32LE()
        return Number(take(8).readBigUInt64LE())
    }
    const version = take(4).readUInt32LE()
    const inputs = Array.from({ length: vi() }, () => ({ txid: Buffer.from(take(32)).reverse().toString('hex'), vout: take(4).readUInt32LE(), script: take(vi()), sequence: take(4).readUInt32LE() }))
    const outputs = Array.from({ length: vi() }, () => ({ value: Number(take(8).readBigUInt64LE()), script: take(vi()) }))
    const locktime = take(4).readUInt32LE()
    if (o !== raw.length) throw new Error('trailing bytes after transaction')
    return { version, inputs, outputs, locktime }
}

// Script pushes after OP_FALSE OP_RETURN, or null if the output isn't one.
export function dataPushes(script) {
    let o = 0
    if (script[0] === 0x00 && script[1] === 0x6a) o = 2
    else if (script[0] === 0x6a) o = 1
    else return null
    const out = []
    while (o < script.length) {
        const op = script[o++]
        let n
        if (op > 0 && op < 0x4c) n = op
        else if (op === 0x4c) n = script[o++]
        else if (op === 0x4d) { n = script.readUInt16LE(o); o += 2 }
        else if (op === 0x4e) { n = script.readUInt32LE(o); o += 4 }
        else return out // a non-push opcode ends the data
        out.push(script.subarray(o, o + n)); o += n
    }
    return out
}

// The jevb anchor in a transaction: { hash (hex), prompt? } or null.
export function findAnchor(raw) {
    for (const out of parseTx(raw).outputs) {
        const p = dataPushes(out.script)
        if (!p || p.length < 3 || p[0].toString() !== TAG || p[1][0] !== FORMAT_VERSION || p[2].length !== 32) continue
        return { hash: p[2].toString('hex'), ...(p[3] && { prompt: p[3].toString('utf8') }) }
    }
    return null
}

// ---- network (only with broadcast / chain lookups) ------------------------

async function api(pathname, init) {
    const res = await fetch(API() + pathname, { ...init, signal: AbortSignal.timeout(20_000) })
    const body = await res.text()
    if (!res.ok) throw new Error(`${API()}${pathname}: HTTP ${res.status} ${body.slice(0, 200)}`)
    try { return JSON.parse(body) } catch { return body }
}

export const fetchTxHex = (id) => api(`/tx/${id}/hex`)
export const fetchTxInfo = (id) => api(`/tx/hash/${id}`)

// hash: 32-byte Buffer. Returns the anchor record that goes in anchor.json.
export async function anchor(hash, { prompt, broadcast = false, wif = process.env.JEVB_BSV_WIF } = {}) {
    if (!broadcast) {
        const key = keyFromSecret(crypto.randomBytes(32))
        const utxo = { txid: sha256(Buffer.from('jevb dry-run funding ' + hash.toString('hex'))).toString('hex'), vout: 0, value: 10_000 }
        const built = buildAnchorTx({ hash, prompt, key, utxo })
        return { dryRun: true, network: 'none', note: 'dry run: signed with a throwaway key over a made-up input; not valid on any chain and never sent', txid: built.txid, rawtx: built.raw.toString('hex'), fee: built.fee, publishedPrompt: prompt != null }
    }
    if (!wif) throw Object.assign(new Error('broadcasting needs JEVB_BSV_WIF (a funded mainnet key) in the environment'), { code: 'NO_KEY' })
    const key = keyFromWif(wif)
    const utxos = await api(`/address/${key.address}/unspent`)
    const pick = [...utxos].sort((a, b) => b.value - a.value)[0]
    if (!pick) throw new Error(`no unspent outputs at ${key.address}; fund it first`)
    const built = buildAnchorTx({ hash, prompt, key, utxo: { txid: pick.tx_hash, vout: pick.tx_pos, value: pick.value } })
    const sent = await api('/tx/raw', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txhex: built.raw.toString('hex') }) })
    const id = String(sent).replace(/"/g, '')
    if (id !== built.txid) throw new Error(`broadcast answered ${id}, expected ${built.txid}`)
    return { dryRun: false, network: 'bsv-main', txid: built.txid, rawtx: built.raw.toString('hex'), fee: built.fee, from: key.address, broadcastAt: new Date().toISOString(), publishedPrompt: prompt != null }
}
