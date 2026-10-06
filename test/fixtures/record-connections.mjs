import { appendFileSync } from "node:fs";
import net from "node:net";

const log = process.env.CONNECTION_LOG;
const connect = net.Socket.prototype.connect;

net.Socket.prototype.connect = function (...args) {
  const target = Array.isArray(args[0]) ? args[0][0] : args[0];
  const where = typeof target === "object" && target !== null ? `${target.host ?? "localhost"}:${target.port}` : `${args[1] ?? "localhost"}:${target}`;
  if (log) appendFileSync(log, `${where}\n`);
  return connect.apply(this, args);
};
