export class BaseAdapter {
  constructor(name, options = {}) {
    this.name = name;
    this.options = options;
    this.bridge = null;
  }

  attach(bridge) {
    this.bridge = bridge;
  }

  async start() {}

  async stop() {}

  async send(_message) {
    throw new Error(`${this.constructor.name}.send() is not implemented`);
  }

  async emitMessage(message) {
    if (!this.bridge) {
      throw new Error(`Adapter ${this.name} is not attached to a bridge`);
    }
    await this.bridge.handleIncoming(message, this.name);
  }
}
