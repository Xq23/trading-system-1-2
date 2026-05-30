#!/usr/bin/env node
/** 本地/服务器 CLI：回测最近 N 根 4h K 线成交量预警 */
import { runVolumeAlertBacktest } from "./volume-alert-scanner.js";

const periods = Number(process.argv[2]) || 2;
const force = process.argv.includes("--force");

console.log(`[volume-backtest] 开始回测最近 ${periods} 根 4h K 线…`);
const result = await runVolumeAlertBacktest({ periods, force });
console.log(JSON.stringify(result, null, 2));
process.exit(0);
