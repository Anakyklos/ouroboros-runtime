#!/usr/bin/env bun
import { runAdminCli } from "../cli/src/commands/admin-cli.js";

process.exitCode = await runAdminCli(process.argv.slice(2));
