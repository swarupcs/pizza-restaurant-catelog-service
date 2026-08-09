import { Category } from "../../src/category/category-types";

/** A valid category body, matching what the admin UI posts. */
export const categoryPayload = (
    overrides: Partial<Category> = {},
): Category => ({
    name: "Pizza",
    priceConfiguration: {
        Size: {
            priceType: "base",
            availableOptions: ["Small", "Medium", "Large"],
        },
        Crust: {
            priceType: "aditional",
            availableOptions: ["Thin", "Thick"],
        },
    },
    attributes: [
        {
            name: "isHit",
            widgetType: "radio",
            defaultValue: "No",
            availableOptions: ["Yes", "No"],
        },
        {
            name: "Spiciness",
            widgetType: "radio",
            defaultValue: "Medium",
            availableOptions: ["Less", "Medium", "Hot"],
        },
    ],
    ...overrides,
});

/**
 * Product fields as they arrive over multipart: priceConfiguration and
 * attributes are JSON *strings*, because the controller JSON.parses them.
 */
export const productFields = (overrides: Record<string, string> = {}) => ({
    name: "Margherita",
    description: "Classic cheese and tomato",
    priceConfiguration: JSON.stringify({
        Size: {
            priceType: "base",
            availableOptions: { Small: 400, Medium: 600, Large: 800 },
        },
    }),
    attributes: JSON.stringify([{ name: "isHit", value: "Yes" }]),
    tenantId: "1",
    categoryId: "65f1b2c3d4e5f6a7b8c9d0e1",
    isPublish: "true",
    ...overrides,
});

/**
 * A product document as the schema actually stores it — nested objects, not
 * JSON strings.
 *
 * The cast is deliberate and confined to this one place. `Product` in
 * product-types.ts declares `priceConfiguration: string` and
 * `attributes: string` (there is a `todo: fix the price configuration type`
 * beside them), which describes the multipart request body rather than the
 * stored document, so `ProductModel.create()` rejects a realistic object.
 */
export const productDocument = (
    overrides: Record<string, unknown> = {},
): never =>
    ({
        name: "Margherita",
        description: "Classic cheese and tomato",
        image: "image-uuid",
        priceConfiguration: {
            Size: {
                priceType: "base",
                availableOptions: { Small: 400, Large: 800 },
            },
        },
        attributes: [{ name: "isHit", value: "Yes" }],
        tenantId: "1",
        isPublish: true,
        ...overrides,
    }) as unknown as never;

/** A tiny in-memory PNG, enough for express-fileupload to accept an attach. */
export const imageBuffer = () =>
    Buffer.from(
        "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
            "01f15c4890000000a49444154789c6300010000050001",
        "hex",
    );
