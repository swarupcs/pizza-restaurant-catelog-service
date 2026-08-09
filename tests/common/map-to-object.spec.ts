import { mapToObject } from "../../src/utils";

// mapToObject exists for one reason: Mongoose stores priceConfiguration as a
// Map, and JSON.stringify turns a Map into `{}`. Every product event
// published to Kafka runs through this, so an empty result here means
// order-service caches a product with no prices.
describe("mapToObject", () => {
    it("should convert a flat map", () => {
        const map = new Map<string, unknown>([
            ["Small", 400],
            ["Large", 800],
        ]);

        expect(mapToObject(map)).toEqual({ Small: 400, Large: 800 });
    });

    it("should return an empty object for an empty map", () => {
        expect(mapToObject(new Map())).toEqual({});
    });

    it("should recurse into nested maps", () => {
        const map = new Map<string, unknown>([
            [
                "Size",
                new Map<string, unknown>([
                    ["priceType", "base"],
                    [
                        "availableOptions",
                        new Map<string, unknown>([["Small", 400]]),
                    ],
                ]),
            ],
        ]);

        expect(mapToObject(map)).toEqual({
            Size: {
                priceType: "base",
                availableOptions: { Small: 400 },
            },
        });
    });

    it("should leave non-map values alone", () => {
        const map = new Map<string, unknown>([
            ["list", [1, 2, 3]],
            ["nested", { a: 1 }],
            ["nothing", null],
        ]);

        expect(mapToObject(map)).toEqual({
            list: [1, 2, 3],
            nested: { a: 1 },
            nothing: null,
        });
    });

    it("should produce something JSON.stringify can serialise", () => {
        // The actual failure this guards: stringifying the Map directly.
        const map = new Map<string, unknown>([["Small", 400]]);

        expect(JSON.stringify(map)).toBe("{}");
        expect(JSON.stringify(mapToObject(map))).toBe('{"Small":400}');
    });
});
