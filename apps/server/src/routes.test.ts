import assert from "node:assert/strict";
import test from "node:test";
import { extractWebArticle, isPrivateAddress } from "./routes.js";

test("网页提取优先使用 article，而不是更长的 body 杂讯", () => {
  const article = "这是正文内容。".repeat(40);
  const noise = "推荐导航广告。".repeat(200);
  const result = extractWebArticle(`<html><head><title>测试文章</title></head><body>${noise}<article>${article}</article>${noise}</body></html>`);
  assert.equal(result.title, "测试文章");
  assert.match(result.content, /这是正文内容/);
  assert.doesNotMatch(result.content, /推荐导航广告/);
});

test("内网、回环、链路本地和IPv4映射地址都会被拦截", () => {
  for (const address of ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.1.1", "::1", "fc00::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress("1.1.1.1"), false);
  assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});
