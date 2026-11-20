import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { layoutReceipt, normalize } from "../src/lib/receipt"

// Generated from the core's format_receipt; regenerate when receipt.py changes.
const cases = JSON.parse(
  readFileSync(new URL("./receipt-cases.json", import.meta.url), "utf8")
) as Record<
  string,
  {
    text: string
    columns?: number
    lines: { style: string; text: string }[]
  }
>

for (const [name, fixture] of Object.entries(cases))
  test(`receipt layout matches the core: ${name}`, () => {
    const layout = layoutReceipt(fixture.text, fixture.columns)
    assert.equal(layout.error, null)
    assert.deepEqual(layout.lines, fixture.lines)
    for (const line of layout.lines)
      assert.ok(
        line.text.length <=
          (line.style === "T" ? layout.columns / 2 : layout.columns),
        `"${line.text}" fits its cells`
      )
  })

test("receipt limits mirror the core", () => {
  assert.match(layoutReceipt("x".repeat(10_001)).error ?? "", /10,000/)
  assert.match(layoutReceipt("a\n".repeat(401)).error ?? "", /400 lines/)
  assert.equal(layoutReceipt("a\n".repeat(399)).error, null)
})

test("normalize keeps line breaks and drops controls", () => {
  assert.equal(normalize("a\u0007b\r\nc\td"), "ab\nc   d")
  assert.equal(normalize("\u{1F600}"), "?")
})
