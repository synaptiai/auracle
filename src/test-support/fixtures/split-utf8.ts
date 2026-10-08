// Writes "€\n" to stdout in two chunks, split inside the character, so a
// reader that decodes each chunk alone sees two replacement characters.
process.stdout.write(Buffer.from([0xe2, 0x82]));
setTimeout(() => process.stdout.write(Buffer.from([0xac, 0x0a])), 100);
