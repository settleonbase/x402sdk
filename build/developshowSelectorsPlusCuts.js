"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.showSelectorsPlusCuts = showSelectorsPlusCuts;
const ethers_1 = require("ethers");
// never add diamondCut selector itself
const DIAMOND_CUT_SELECTOR = "0x1f931c1c";
function abiArray(abiJson) {
    const abi = Array.isArray(abiJson) ? abiJson : abiJson?.abi;
    if (!Array.isArray(abi))
        throw new Error("Bad ABI JSON: expected array or {abi:[...]}");
    return abi;
}
/**
 * ✅ 最稳的 selectors 生成方式：用 Interface.getFunction(...).selector
 * - 支持 tuple/struct
 * - 去重、lowercase
 * - 可选择过滤掉 diamondCut selector
 */
function getSelectorsFromAbi(abiJson, opts) {
    const iface = new ethers_1.ethers.Interface(abiArray(abiJson));
    const sels = [];
    for (const frag of iface.fragments) {
        if (frag.type !== "function")
            continue;
        // 这里用 format() 拼完整 signature 以避免 overload 误取
        // ethers v6: FunctionFragment.format("full")
        const sig = frag.format("full"); // e.g. "foo(uint256,(address,uint256))"
        const fn = iface.getFunction(sig);
        if (!fn)
            continue;
        sels.push(fn.selector.toLowerCase());
    }
    const unique = [...new Set(sels)];
    if (opts?.filterDiamondCut) {
        return unique.filter((s) => s !== DIAMOND_CUT_SELECTOR);
    }
    return unique;
}
/**
 * 输出：
 * 1) 每个 facet 的 selectors
 * 2) cuts JSON（Remix diamondCut 直接粘贴）
 */
function showSelectorsPlusCuts(planList) {
    const perFacet = [];
    // 1) 打印 selectors
    console.log("== SELECTORS (per facet) ==");
    for (const x of planList) {
        const selectors = getSelectorsFromAbi(x.abi, { filterDiamondCut: true });
        perFacet.push({
            name: x.name,
            facetAddress: x.facet,
            selectors,
        });
        console.log(`\n[${x.name}] facet= ${x.facet}`);
        console.log(`selectors (${selectors.length}) =`, `selectors (${selectors.length}) = [${selectors.map(s => `"${s}"`).join(', ')}]`);
    }
    // 2) 生成 cuts（action=0 Add）
    const cuts = perFacet.map((x) => ({
        facetAddress: x.facetAddress,
        action: 0, // Add
        functionSelectors: x.selectors,
    }));
    console.log("\n== CUTS JSON (paste into Remix diamondCut) ==");
    console.log(JSON.stringify(cuts, null, 2));
    // 3) 额外：检查 ABI 内是否出现 selector 冲突（跨 facet 重复）
    const seen = new Map();
    for (const x of perFacet) {
        for (const sel of x.selectors) {
            const arr = seen.get(sel) || [];
            arr.push(x.name);
            seen.set(sel, arr);
        }
    }
    const collisions = [...seen.entries()].filter(([, owners]) => owners.length > 1);
    console.log("\n== COLLISION CHECK ==");
    if (!collisions.length) {
        console.log("✅ No selector collisions across the given ABIs");
    }
    else {
        console.log("⚠️ Found selector collisions (same selector appears in multiple facets):");
        for (const [sel, owners] of collisions) {
            console.log(`  ${sel}  <=  ${owners.join(" , ")}`);
        }
        console.log("⚠️ 如果这些 facets 都 Add 到 diamond，会导致 diamondCut revert（selector 已存在/冲突）。");
    }
    // 4) 总览统计
    const totalSelectors = perFacet.reduce((acc, x) => acc + x.selectors.length, 0);
    console.log("\n== SUMMARY ==");
    console.log(`facets=${perFacet.length}, totalSelectors=${totalSelectors}`);
}
