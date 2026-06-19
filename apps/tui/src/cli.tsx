#!/usr/bin/env -S npx tsx
import React from "react";
import { render } from "ink";
import { Engine } from "@devhub/engine";
import { App } from "./app.js";

const engine = new Engine();
const { waitUntilExit } = render(<App engine={engine} />);
await waitUntilExit();
engine.close();
