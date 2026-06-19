/* Non-interactive smoke: render the first frame with ink-testing-library. */
import React from "react";
import { render } from "ink-testing-library";
import { Engine } from "@devhub/engine";
import { App } from "./app.js";

const engine = new Engine();
const { lastFrame, unmount } = render(<App engine={engine} />);
setTimeout(() => {
  console.log("----- TUI first frame -----");
  console.log(lastFrame());
  console.log("---------------------------");
  unmount();
  engine.close();
  process.exit(0);
}, 250);
