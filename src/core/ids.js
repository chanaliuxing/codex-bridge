import crypto from "node:crypto";

export function makeId(prefix = "msg") {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
}
