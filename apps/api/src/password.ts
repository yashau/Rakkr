import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const passwordHashVersion = "scrypt";
const passwordKeyLength = 64;
const scryptCost = 16_384;
const scryptBlockSize = 8;
const scryptParallelization = 1;
const scryptMaxMemory = 64 * 1024 * 1024;

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("base64url");
  const key = await scrypt(password, salt, passwordKeyLength, {
    N: scryptCost,
    maxmem: scryptMaxMemory,
    p: scryptParallelization,
    r: scryptBlockSize,
  });

  return [
    passwordHashVersion,
    scryptCost,
    scryptBlockSize,
    scryptParallelization,
    salt,
    key.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(password: string, encodedHash: string) {
  const [version, cost, blockSize, parallelization, salt, expectedHash] = encodedHash.split("$");

  if (version !== passwordHashVersion || !salt || !expectedHash) {
    return false;
  }

  const key = await scrypt(password, salt, passwordKeyLength, {
    N: Number(cost),
    maxmem: scryptMaxMemory,
    p: Number(parallelization),
    r: Number(blockSize),
  });
  const expected = Buffer.from(expectedHash, "base64url");

  return expected.length === key.length && timingSafeEqual(expected, key);
}

function scrypt(
  password: string,
  salt: string,
  keyLength: number,
  options: Parameters<typeof scryptCallback>[3],
) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(derivedKey);
    });
  });
}
