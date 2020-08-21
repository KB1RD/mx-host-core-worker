function generateUniqueKey(
  bytes = 16,
  isInUse: (k: string) => boolean = () => false
): string {
  let key: string
  do {
    key = ''
    // Create a random unsigned 128 bit uint encoded as base16
    // (16 groups of 2 chars, 4 bits per char)
    for (let i = 0; i < bytes; i++) {
      key += Math.floor(Math.random() * 255)
        .toString(16)
        .padStart(2, '0')
    }
  } while (isInUse(key))
  return key
}

export { generateUniqueKey }
