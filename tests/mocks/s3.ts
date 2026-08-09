/**
 * Stand-in for src/common/services/S3Storage.
 *
 * The routers construct `new S3Storage()` at module load, so a spec that
 * imports the app would otherwise build a real S3 client and, on upload,
 * reach out to AWS. Specs opt in with:
 *
 *     jest.mock("../../src/common/services/S3Storage", () => require("../mocks/s3"));
 *
 * and then assert against the exported jest.fn()s directly.
 */
export const upload = jest.fn<Promise<void>, [unknown]>();
export const remove = jest.fn<Promise<void>, [string]>();
export const getObjectUri = jest.fn(
    (filename: string) =>
        `https://catalog-service-test.s3.ap-south-1.amazonaws.com/${filename}`,
);

export const S3Storage = jest.fn().mockImplementation(() => ({
    upload,
    // `delete` is a reserved word, so the spy is named `remove` and wired in
    // under the real method name here.
    delete: remove,
    getObjectUri,
}));

/** Clears call history without discarding the getObjectUri implementation. */
export const resetS3Mocks = () => {
    upload.mockClear();
    remove.mockClear();
    getObjectUri.mockClear();
};
