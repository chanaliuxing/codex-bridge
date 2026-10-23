import { BaseAdapter } from "./base-adapter.js";

export class ConsoleAdapter extends BaseAdapter {
  async send(message) {
    const line = [
      "",
      `[console] thread=${message.threadId} from=${message.from} to=${message.to ?? "-"}`,
      message.text
    ].join("\n");
    console.log(line);
  }
}
