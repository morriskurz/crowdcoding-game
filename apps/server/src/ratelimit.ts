// Token bucket: 10 msg/s per connection. Q10.
export class RateLimit {
  tokens = 10;
  last = Date.now();
  hit(): boolean {
    const now = Date.now();
    this.tokens = Math.min(10, this.tokens + ((now - this.last) / 1000) * 10);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
