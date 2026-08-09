import request from "supertest";
import createJWKSMock from "mock-jwks";

jest.mock("../../src/common/services/S3Storage", () => require("../mocks/s3"));
jest.mock("../../src/common/factories/brokerFactory", () =>
    require("../mocks/broker"),
);

import app from "../../src/app";
import ProductModel from "../../src/product/product-model";
import { Roles } from "../../src/common/constants";
import { clearDb, connectDb, disconnectDb } from "../utils/db";
import { imageBuffer, productFields } from "../utils/fixtures";
import { resetS3Mocks, upload } from "../mocks/s3";
import {
    publishedMessage,
    resetBrokerMocks,
    sendMessage,
} from "../mocks/broker";

describe("POST /products", () => {
    let jwks: ReturnType<typeof createJWKSMock>;
    let adminToken: string;

    beforeAll(async () => {
        jwks = createJWKSMock("http://localhost:5501");
        await connectDb();
    });

    beforeEach(async () => {
        jwks.start();
        await clearDb();
        resetS3Mocks();
        resetBrokerMocks();
        adminToken = jwks.token({ sub: "1", role: Roles.ADMIN });
    });

    afterEach(() => {
        jwks.stop();
    });

    afterAll(async () => {
        await disconnectDb();
    });

    /** Posts a product as multipart, the way the admin UI does. */
    const postProduct = (
        token: string,
        fields: Record<string, string> = productFields(),
        attachImage = true,
    ) => {
        const req = request(app)
            .post("/products")
            .set("Cookie", [`accessToken=${token}`]);

        Object.entries(fields).forEach(([key, value]) => req.field(key, value));

        if (attachImage) {
            req.attach("image", imageBuffer(), "pizza.png");
        }

        return req;
    };

    describe("Given all fields", () => {
        it("should return the 200 status code and the new id", async () => {
            const response = await postProduct(adminToken);

            expect(response.statusCode).toBe(200);
            expect(response.body as { id: string }).toHaveProperty("id");
        });

        it("should persist the product", async () => {
            await postProduct(adminToken);

            const products = await ProductModel.find();

            expect(products).toHaveLength(1);
            expect(products[0].name).toBe("Margherita");
            expect(products[0].tenantId).toBe("1");
        });

        it("should parse priceConfiguration and attributes out of their JSON strings", async () => {
            // They arrive as strings because the request is multipart, and the
            // controller JSON.parses both.
            await postProduct(adminToken);

            const product = await ProductModel.findOne({
                name: "Margherita",
            }).lean();
            const config = product!.priceConfiguration as unknown as Record<
                string,
                { priceType: string; availableOptions: Record<string, number> }
            >;

            expect(config.Size.priceType).toBe("base");
            expect(config.Size.availableOptions.Medium).toBe(600);
            expect(product!.attributes).toHaveLength(1);
        });

        it("should upload the image and store the generated name", async () => {
            await postProduct(adminToken);

            expect(upload).toHaveBeenCalledTimes(1);

            const uploaded = upload.mock.calls[0][0] as { filename: string };
            const product = await ProductModel.findOne({ name: "Margherita" });

            // The stored name is the uuid the controller generated, not the
            // client-supplied filename — so two tenants uploading pizza.png
            // cannot collide.
            expect(product!.image).toBe(uploaded.filename);
            expect(product!.image).not.toBe("pizza.png");
            expect(product!.image).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
            );
        });

        it("should publish a PRODUCT_CREATE event on the product topic", async () => {
            // order-service consumes this to keep its local price cache warm,
            // which is what lets checkout price an order without calling us.
            await postProduct(adminToken);

            expect(sendMessage).toHaveBeenCalledTimes(1);

            const { topic, body } = publishedMessage();
            const product = await ProductModel.findOne({ name: "Margherita" });

            expect(topic).toBe("product");
            expect(body.event_type).toBe("PRODUCT_CREATE");
            expect((body.data as { id: string }).id).toBe(
                product!._id.toString(),
            );
        });

        it("should include the price configuration in the published event", async () => {
            await postProduct(adminToken);

            const { body } = publishedMessage();
            const data = body.data as {
                priceConfiguration: Record<
                    string,
                    { availableOptions: Record<string, number> }
                >;
            };

            expect(data.priceConfiguration.Size.availableOptions.Large).toBe(
                800,
            );
        });

        it("should default isPublish to false when it is not sent", async () => {
            const fields = productFields();
            delete (fields as Partial<typeof fields>).isPublish;

            await postProduct(adminToken, fields);

            // The cast is needed because the `Product` interface in
            // product-types.ts omits `isPublish`, even though the schema
            // defines it and the controller writes it.
            const product = (await ProductModel.findOne({
                name: "Margherita",
            }).lean()) as unknown as { isPublish: boolean };

            expect(product.isPublish).toBe(false);
        });

        it("should store isPublish when it is sent as true", async () => {
            await postProduct(adminToken);

            const product = (await ProductModel.findOne({
                name: "Margherita",
            }).lean()) as unknown as { isPublish: boolean };

            expect(product.isPublish).toBe(true);
        });

        it("should let a manager create a product", async () => {
            const managerToken = jwks.token({
                sub: "2",
                role: Roles.MANAGER,
                tenant: "1",
            });

            const response = await postProduct(managerToken);

            expect(response.statusCode).toBe(200);
        });
    });

    describe("Given invalid fields", () => {
        it.each([
            "name",
            "description",
            "priceConfiguration",
            "attributes",
            "tenantId",
            "categoryId",
        ])("should return 400 when %s is missing", async (field) => {
            const fields = productFields();
            delete fields[field as keyof typeof fields];

            const response = await postProduct(adminToken, fields);

            expect(response.statusCode).toBe(400);
        });

        it("should not persist or publish anything when validation fails", async () => {
            const fields = productFields();
            delete (fields as Partial<typeof fields>).name;

            await postProduct(adminToken, fields);

            expect(await ProductModel.find()).toHaveLength(0);
            expect(sendMessage).not.toHaveBeenCalled();
        });

        it("should return 400 when the image exceeds the 500kb limit", async () => {
            const req = request(app)
                .post("/products")
                .set("Cookie", [`accessToken=${adminToken}`]);

            Object.entries(productFields()).forEach(([key, value]) =>
                req.field(key, value),
            );
            req.attach("image", Buffer.alloc(600 * 1024), "big.png");

            const response = await req;

            expect(response.statusCode).toBe(400);
        });

        it("should return 500 when no image is attached", async () => {
            // BUG, captured rather than asserted as correct. The image check
            // in create-product-validator is commented out, so the controller
            // reaches `req.files!.image` with req.files null, throws a
            // TypeError, and asyncWrapper reports 500. Restoring that
            // validator rule turns this into a 400 with a usable message.
            //
            // create-topping-validator has the rule, but its controller never
            // reads the result — so both routes 500 here, for two different
            // reasons. See tests/topping/create.spec.ts.
            const response = await postProduct(
                adminToken,
                productFields(),
                false,
            );

            expect(response.statusCode).toBe(500);
            expect(await ProductModel.find()).toHaveLength(0);
        });
    });

    describe("Access control", () => {
        it("should return 401 if the caller is not authenticated", async () => {
            const req = request(app).post("/products");
            Object.entries(productFields()).forEach(([key, value]) =>
                req.field(key, value),
            );
            req.attach("image", imageBuffer(), "pizza.png");

            const response = await req;

            expect(response.statusCode).toBe(401);
            expect(await ProductModel.find()).toHaveLength(0);
        });

        it("should return 403 if the caller is a customer", async () => {
            const customerToken = jwks.token({
                sub: "3",
                role: Roles.CUSTOMER,
            });

            const response = await postProduct(customerToken);

            expect(response.statusCode).toBe(403);
            expect(await ProductModel.find()).toHaveLength(0);
        });

        it("should not upload to storage when authorisation fails", async () => {
            const customerToken = jwks.token({
                sub: "3",
                role: Roles.CUSTOMER,
            });

            await postProduct(customerToken);

            expect(upload).not.toHaveBeenCalled();
        });
    });
});
