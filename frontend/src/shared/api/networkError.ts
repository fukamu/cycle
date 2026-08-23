export class NetworkError extends TypeError {
  constructor() {
    super("network request failed");
    this.name = "NetworkError";
  }
}
