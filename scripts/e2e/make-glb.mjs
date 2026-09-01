// Build a real, spec-valid glTF 2.0 binary: an indexed cube with a material.
// Not a stub — it must actually parse and render in three.js/model-viewer,
// because that is the whole point of the fixture.
import fs from 'fs'

const P = new Float32Array([
  -1,-1,-1,  1,-1,-1,  1, 1,-1, -1, 1,-1,
  -1,-1, 1,  1,-1, 1,  1, 1, 1, -1, 1, 1,
])
const I = new Uint16Array([
  0,1,2, 0,2,3,   4,6,5, 4,7,6,   0,4,5, 0,5,1,
  1,5,6, 1,6,2,   2,6,7, 2,7,3,   3,7,4, 3,4,0,
])
const pad4 = (n) => (n + 3) & ~3
const idxBytes = pad4(I.byteLength)
const bin = Buffer.alloc(idxBytes + P.byteLength)
Buffer.from(I.buffer).copy(bin, 0)
Buffer.from(P.buffer).copy(bin, idxBytes)

const json = {
  asset: { version: '2.0', generator: 'kismet-e2e-fixture' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 1 }, indices: 0, material: 0 }] }],
  materials: [{
    pbrMetallicRoughness: {
      baseColorFactor: [0.55, 0.25, 0.95, 1], // a loud purple: obvious in a screenshot
      metallicFactor: 0.1, roughnessFactor: 0.5,
    },
  }],
  accessors: [
    { bufferView: 0, componentType: 5123, count: I.length, type: 'SCALAR' },
    { bufferView: 1, componentType: 5126, count: 8, type: 'VEC3',
      min: [-1,-1,-1], max: [1,1,1] },
  ],
  bufferViews: [
    { buffer: 0, byteOffset: 0, byteLength: I.byteLength, target: 34963 },
    { buffer: 0, byteOffset: idxBytes, byteLength: P.byteLength, target: 34962 },
  ],
  buffers: [{ byteLength: bin.length }],
}

let jsonBuf = Buffer.from(JSON.stringify(json), 'utf8')
if (jsonBuf.length % 4) jsonBuf = Buffer.concat([jsonBuf, Buffer.alloc(4 - (jsonBuf.length % 4), 0x20)])

const chunk = (buf, type) => {
  const h = Buffer.alloc(8)
  h.writeUInt32LE(buf.length, 0)
  h.writeUInt32LE(type, 4)
  return Buffer.concat([h, buf])
}
const jsonChunk = chunk(jsonBuf, 0x4e4f534a)      // 'JSON'
const binChunk = chunk(bin, 0x004e4942)           // 'BIN\0'
const header = Buffer.alloc(12)
header.write('glTF', 0, 'ascii')
header.writeUInt32LE(2, 4)
header.writeUInt32LE(12 + jsonChunk.length + binChunk.length, 8)

const out = Buffer.concat([header, jsonChunk, binChunk])
fs.writeFileSync(process.argv[2] ?? 'cube.glb', out)
console.log('wrote', process.argv[2], out.length, 'bytes; declared', header.readUInt32LE(8))
