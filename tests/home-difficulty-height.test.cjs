const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("recent difficulty follows block height through backward and equal timestamps", async () => {
    let component;
    const window = {
        Vue: { createApp(options) { component = options; return { mount() {} }; } },
        Chart: class { constructor(context, config) { this.config = config; } },
        moment: {},
        getComputedStyle() { return { getPropertyValue() { return ""; } }; }
    };
    const source = readFileSync(path.join(__dirname, "../js/app.js"), "utf8");
    vm.runInNewContext(source, { window, document: { documentElement: {} } });

    // The home feed is newest first. Blocks 103323–103326 are from mainnet.
    const blocks = [
        { height: 103326, timestamp: 1794436305, difficulty: 116000000 },
        { height: 103325, timestamp: 1794436305, difficulty: 113000000 },
        { height: 103324, timestamp: 1794436219, difficulty: 109000000 },
        { height: 103323, timestamp: 1794436288, difficulty: 108000000 }
    ];
    let destination;
    const home = {
        ...component.methods,
        home: { blocks },
        route: { name: "home" },
        charts: {},
        $refs: { difficultyCanvas: { getContext() { return {}; } } },
        goTo(route) { destination = route; }
    };
    home.difficultyChart = component.computed.difficultyChart.call(home);
    await home.renderDifficultyChart();

    const { data, options } = home.charts.difficulty.config;
    const ordered = blocks.slice().reverse();
    assert.deepEqual(Array.from(data.datasets[0].data, point => [point.x, point.y]),
        ordered.map(block => [block.height, block.difficulty]));
    assert.equal(options.scales.xAxes[0].type, "linear");

    for (const [index, block] of ordered.entries()) {
        const items = [{ index }];
        assert.equal(options.tooltips.callbacks.title(items), "Block " + home.formatNumber(block.height));
        assert.equal(options.tooltips.callbacks.afterTitle(items), home.formatDateTime(block.timestamp));
        options.onClick({}, [{ _index: index }]);
        assert.equal(destination.name, "block");
        assert.equal(destination.params.hash, String(block.height));
    }
});
