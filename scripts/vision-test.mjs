import zlib from "node:zlib";
const w = 8, h = 8;
const raw = Buffer.alloc(h * (1 + w * 3));
for (let y = 0; y < h; y++) {
  raw[y * (1 + w * 3)] = 0;
  for (let x = 0; x < w; x++) {
    const o = y * (1 + w * 3) + 1 + x * 3;
    raw[o] = 255; raw[o + 1] = 0; raw[o + 2] = 0;
  }
}
const idat = zlib.deflateSync(raw);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b; };
const chunk = (type, data) => {
  const t = Buffer.from(type, "ascii");
  const td = Buffer.concat([t, data]);
  let c = -1;
  for (let i = 0; i < td.length; i++) {
    c = c ^ td[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  c = (c ^ -1) >>> 0;
  return Buffer.concat([u32(data.length), t, data, u32(c)]);
};
const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
const ihdr = Buffer.concat([u32(w), u32(h), Buffer.from([8, 2, 0, 0, 0])]);
const png = Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
const dataUrl = "data:image/png;base64," + png.toString("base64");

const r = await fetch("http://localhost:3000/api/chat", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    sessionKey: "vision_node",
    sessionId: "vn",
    messages: [{
      role: "user",
      parts: [
        { type: "text", text: "What primary color do you see in this image? Answer with one word from: red, green, blue." },
        { type: "file", mediaType: "image/png", url: dataUrl },
      ],
    }],
  }),
});
const txt = await r.text();
const deltas = (txt.match(/"delta":"([^"]*)"/g) ?? []).map((s) => s.slice(10, -1)).join("");
console.log("reply:", deltas);
