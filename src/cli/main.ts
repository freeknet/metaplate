#!/usr/bin/env node

import process from "node:process";
import { runBinary } from "./run.js";

void runBinary(process.argv.slice(2));
