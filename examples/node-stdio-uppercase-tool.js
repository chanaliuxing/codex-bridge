import { runStdioTool } from "../sdk/node/bridge-tool-sdk.js";

runStdioTool("stdio_upper", async (message) => {
  return {
    text: String(message.text ?? "").toUpperCase()
  };
});
