'use strict';

function readImageDimensions(data) {
  if (!Buffer.isBuffer(data) || data.length < 10) throw new Error('The image is invalid or truncated.');

  if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    && data.subarray(12, 16).toString('ascii') === 'IHDR') {
    return { type: 'png', width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }

  const gifHeader = data.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { type: 'gif', width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }

  if (data[0] === 0xff && data[1] === 0xd8) {
    const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
    let offset = 2;
    for (let segments = 0; segments < 256 && offset + 3 < data.length; segments += 1) {
      while (offset < data.length && data[offset] === 0xff) offset += 1;
      const marker = data[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > data.length) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if (startOfFrame.has(marker) && length >= 7) {
        return { type: 'jpg', height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
      }
      offset += length;
    }
  }

  throw new Error('The image format is invalid or unsupported.');
}

module.exports = { readImageDimensions };
