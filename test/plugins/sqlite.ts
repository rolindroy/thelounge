/* eslint-disable @typescript-eslint/no-unsafe-return */
import fs from "fs";
import path from "path";
import {expect} from "chai";
import util from "../util";
import Msg, {MessageType} from "../../server/models/msg";
import Config from "../../server/config";
import MessageStorage from "../../server/plugins/messageStorage/sqlite";
import Client from "../../server/client";

describe("SQLite Message Storage", function () {
	// Increase timeout due to unpredictable I/O on CI services
	this.timeout(util.isRunningOnCI() ? 25000 : 5000);
	this.slow(300);

	const expectedPath = path.join(Config.getHomePath(), "logs", "testUser.sqlite3");
	let store: MessageStorage;

	before(function (done) {
		store = new MessageStorage({
			name: "testUser",
			idMsg: 1,
		} as Client);

		// Delete database file from previous test run
		if (fs.existsSync(expectedPath)) {
			fs.unlink(expectedPath, done);
		} else {
			done();
		}
	});

	after(function (done) {
		// After tests run, remove the logs folder
		// so we return to the clean state
		fs.unlinkSync(expectedPath);
		fs.rmdir(path.join(Config.getHomePath(), "logs"), done);
	});

	it("should resolve an empty array when disabled", function () {
		return store.getMessages(null as any, null as any).then((messages) => {
			expect(messages).to.be.empty;
		});
	});

	it("should create database file", function () {
		expect(store.isEnabled).to.be.false;
		expect(fs.existsSync(expectedPath)).to.be.false;

		store.enable();

		expect(store.isEnabled).to.be.true;
	});

	it("should create tables", function (done) {
		store.database.all(
			"SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'table'",
			(err, row) => {
				expect(err).to.be.null;
				expect(row).to.deep.equal([
					{
						name: "options",
						tbl_name: "options",
						sql: "CREATE TABLE options (name TEXT, value TEXT, CONSTRAINT name_unique UNIQUE (name))",
					},
					{
						name: "messages",
						tbl_name: "messages",
						sql: "CREATE TABLE messages (network TEXT, channel TEXT, time INTEGER, type TEXT, msg TEXT)",
					},
				]);

				done();
			}
		);
	});

	it("should insert schema version to options table", function (done) {
		store.database.get(
			"SELECT value FROM options WHERE name = 'schema_version'",
			(err, row) => {
				expect(err).to.be.null;

				// Should be sqlite.currentSchemaVersion,
				// compared as string because it's returned as such from the database
				expect(row.value).to.equal("1520239200");

				done();
			}
		);
	});

	it("should store a message", function () {
		store.index(
			{
				uuid: "this-is-a-network-guid",
			} as any,
			{
				name: "#thisISaCHANNEL",
			} as any,
			new Msg({
				time: 123456789,
				text: "Hello from sqlite world!",
			} as any)
		);
	});

	it("should retrieve previously stored message", function () {
		return store
			.getMessages(
				{
					uuid: "this-is-a-network-guid",
				} as any,
				{
					name: "#thisisaCHANNEL",
				} as any
			)
			.then((messages) => {
				expect(messages).to.have.lengthOf(1);

				const msg = messages[0];

				expect(msg.text).to.equal("Hello from sqlite world!");
				expect(msg.type).to.equal(MessageType.MESSAGE);
				expect(msg.time.getTime()).to.equal(123456789);
			});
	});

	it("should retrieve latest LIMIT messages in order", function () {
		const originalMaxHistory = Config.values.maxHistory;

		try {
			Config.values.maxHistory = 2;

			for (let i = 0; i < 200; ++i) {
				store.index(
					{uuid: "retrieval-order-test-network"} as any,
					{name: "#channel"} as any,
					new Msg({
						time: 123456789 + i,
						text: `msg ${i}`,
					} as any)
				);
			}

			return store
				.getMessages(
					{uuid: "retrieval-order-test-network"} as any,
					{name: "#channel"} as any
				)
				.then((messages) => {
					expect(messages).to.have.lengthOf(2);
					expect(messages.map((i) => i.text)).to.deep.equal(["msg 198", "msg 199"]);
				});
		} finally {
			Config.values.maxHistory = originalMaxHistory;
		}
	});

	it("should search messages", function () {
		const originalMaxHistory = Config.values.maxHistory;

		try {
			Config.values.maxHistory = 2;

			return store
				.search({
					searchTerm: "msg",
					networkUuid: "retrieval-order-test-network",
				} as any)
				.then((messages) => {
					// @ts-expect-error Property 'results' does not exist on type '[]'.
					expect(messages.results).to.have.lengthOf(100);

					const expectedMessages: string[] = [];

					for (let i = 100; i < 200; ++i) {
						expectedMessages.push(`msg ${i}`);
					}

					// @ts-expect-error Property 'results' does not exist on type '[]'.
					expect(messages.results.map((i) => i.text)).to.deep.equal(expectedMessages);
				});
		} finally {
			Config.values.maxHistory = originalMaxHistory;
		}
	});

	it("should search messages with escaped wildcards", function () {
		function assertResults(query, expected) {
			return store
				.search({
					searchTerm: query,
					networkUuid: "this-is-a-network-guid2",
				} as any)
				.then((messages) => {
					// @ts-expect-error Property 'results' does not exist on type '[]'.
					expect(messages.results.map((i) => i.text)).to.deep.equal(expected);
				});
		}

		const originalMaxHistory = Config.values.maxHistory;

		try {
			Config.values.maxHistory = 3;

			store.index(
				{uuid: "this-is-a-network-guid2"} as any,
				{name: "#channel"} as any,
				new Msg({
					time: 123456790,
					text: `foo % bar _ baz`,
				} as any)
			);

			store.index(
				{uuid: "this-is-a-network-guid2"} as any,
				{name: "#channel"} as any,
				new Msg({
					time: 123456791,
					text: `foo bar x baz`,
				} as any)
			);

			store.index(
				{uuid: "this-is-a-network-guid2"} as any,
				{name: "#channel"} as any,
				new Msg({
					time: 123456792,
					text: `bar @ baz`,
				} as any)
			);

			return (
				store
					.getMessages(
						{uuid: "this-is-a-network-guid2"} as any,
						{name: "#channel"} as any
					)
					// .getMessages() waits for store.index() transactions to commit
					.then(() => assertResults("foo", ["foo % bar _ baz", "foo bar x baz"]))
					.then(() => assertResults("%", ["foo % bar _ baz"]))
					.then(() => assertResults("foo % bar ", ["foo % bar _ baz"]))
					.then(() => assertResults("_", ["foo % bar _ baz"]))
					.then(() => assertResults("bar _ baz", ["foo % bar _ baz"]))
					.then(() => assertResults("%%", []))
					.then(() => assertResults("@%", []))
					.then(() => assertResults("@", ["bar @ baz"]))
			);
		} finally {
			Config.values.maxHistory = originalMaxHistory;
		}
	});

	it("should close database", function (done) {
		store.close((err) => {
			expect(err).to.be.null;
			expect(fs.existsSync(expectedPath)).to.be.true;
			done();
		});
	});
});
