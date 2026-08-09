import request from "supertest";

jest.mock("../src/common/services/S3Storage", () => require("./mocks/s3"));
jest.mock("../src/common/factories/brokerFactory", () =>
    require("./mocks/broker"),
);

import app from "../src/app";

// App-level behaviour: no database, no controllers.
//
// This replaces the previous root-level app.spec.ts, which could not compile
// — it imported `calculateDiscount` from src/utils, which only exports
// `mapToObject`. That single broken import meant the service's only test file
// never ran. Its one meaningful assertion (GET / returns 200) is kept below.
describe("app", () => {
    describe("GET /", () => {
        it("should return the 200 status code", async () => {
            const response = await request(app).get("/").send();

            expect(response.statusCode).toBe(200);
        });

        it("should return the health-check greeting", async () => {
            const response = await request(app).get("/").send();

            expect(response.body as { message: string }).toEqual({
                message: "Hello from catalog service!",
            });
        });
    });

    describe("Unknown routes", () => {
        it("should return 404 for a path that is not mounted", async () => {
            const response = await request(app).get("/does-not-exist").send();

            expect(response.statusCode).toBe(404);
        });

        it("should return 404 for a method the route does not handle", async () => {
            // /categories exists for GET and POST, not DELETE.
            const response = await request(app).delete("/categories").send();

            expect(response.statusCode).toBe(404);
        });
    });

    describe("Body parsing", () => {
        it("should return 400 for a malformed JSON body", async () => {
            const response = await request(app)
                .post("/categories")
                .set("Content-Type", "application/json")
                .send("{ not valid json");

            // express.json() rejects it before authenticate ever runs, so
            // this is a 400 rather than the 401 an unauthenticated POST to
            // /categories would normally get.
            expect(response.statusCode).toBe(400);
        });
    });

    describe("CORS", () => {
        it("should echo an allowed origin with credentials enabled", async () => {
            // config/test.yaml lists the client UI as an allowed origin, and
            // credentials must be on because the access token travels as an
            // httpOnly cookie.
            const response = await request(app)
                .get("/")
                .set("Origin", "http://localhost:5173")
                .send();

            expect(response.headers["access-control-allow-origin"]).toBe(
                "http://localhost:5173",
            );
            expect(response.headers["access-control-allow-credentials"]).toBe(
                "true",
            );
        });

        it("should allow the admin UI origin too", async () => {
            const response = await request(app)
                .get("/")
                .set("Origin", "http://localhost:5174")
                .send();

            expect(response.headers["access-control-allow-origin"]).toBe(
                "http://localhost:5174",
            );
        });

        it("should not grant access to an unlisted origin", async () => {
            const response = await request(app)
                .get("/")
                .set("Origin", "https://evil.example.com")
                .send();

            expect(response.headers["access-control-allow-origin"]).not.toBe(
                "https://evil.example.com",
            );
        });
    });
});
