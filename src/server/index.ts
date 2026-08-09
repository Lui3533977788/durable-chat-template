import {
	type Connection,
	type ConnectionContext,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

import {
	normalizeRoomName,
	type AccountInfo,
	type AccountMessage,
	type ChatMessage,
	type Message,
	type ReplyTo,
	type RoomsMessage,
} from "../shared";

export class Chat extends Server<Env> {
	static options = { hibernate: true };

	messages = [] as ChatMessage[];
	typingUsers = new Map<string, string>();

	broadcastMessage(message: Message, exclude?: string[]) {
		this.broadcast(JSON.stringify(message), exclude);
	}

	broadcastTyping(exclude?: string[]) {
		this.broadcast(
			JSON.stringify({
				type: "typing",
				users: [...this.typingUsers.values()],
			} satisfies Message),
			exclude,
		);
	}

	onStart() {
		// this is where you can initialize things that need to be done before the server starts
		// for example, load previous messages from a database or a service

		// create the messages table if it doesn't exist
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, userId TEXT, role TEXT, content TEXT, media TEXT, timestamp INTEGER, replyTo TEXT)`,
		);

		// add the media column to existing tables (no-op once it exists)
		try {
			this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN media TEXT`);
		} catch (e) {
			// column already exists
		}

		// add the timestamp column to existing tables (no-op once it exists)
		try {
			this.ctx.storage.sql.exec(
				`ALTER TABLE messages ADD COLUMN timestamp INTEGER`,
			);
		} catch (e) {
			// column already exists
		}

		// add the replyTo column to existing tables (no-op once it exists)
		try {
			this.ctx.storage.sql.exec(
				`ALTER TABLE messages ADD COLUMN replyTo TEXT`,
			);
		} catch (e) {
			// column already exists
		}

		// add the userId column to existing tables (no-op once it exists)
		try {
			this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN userId TEXT`);
		} catch (e) {
			// column already exists
		}

		// load the messages from the database
		this.messages = (
			this.ctx.storage.sql
				.exec(`SELECT * FROM messages`)
				.toArray() as Array<Record<string, unknown>>
		).map((row) => ({
			id: row.id as string,
			user: row.user as string,
			userId: (row.userId as string) ?? undefined,
			role: row.role as "user" | "assistant",
			content: row.content as string,
			media: (row.media as string) ?? undefined,
			timestamp: (row.timestamp as number) ?? undefined,
			replyTo: row.replyTo
				? (JSON.parse(row.replyTo as string) as ReplyTo)
				: undefined,
		}));
	}

	async onConnect(connection: Connection, ctx: ConnectionContext) {
		// resolve the account behind this connection so the server can stamp
		// messages with the real name (no impersonation, even with devtools)
		const token = new URL(ctx.request.url).searchParams.get("token");
		let identity: AccountInfo | null = null;
		if (token) {
			try {
				const res = await this.env.Accounts.get(
					this.env.Accounts.idFromName("registry"),
				).fetch("https://accounts/resolve", {
					method: "POST",
					headers: { "x-partykit-room": "registry" },
					body: token,
				});
				if (res.ok) {
					identity = (await res.json()) as AccountInfo;
				}
			} catch (e) {
				console.error("Failed to resolve session", e);
			}
		}
		if (identity) {
			connection.setState(identity);
		}
		connection.send(
			JSON.stringify({
				type: "all",
				messages: this.messages,
			} satisfies Message),
		);
	}

	saveMessage(message: ChatMessage) {
		// check if the message already exists
		const existingMessage = this.messages.find((m) => m.id === message.id);
		if (existingMessage) {
			this.messages = this.messages.map((m) => {
				if (m.id === message.id) {
					return message;
				}
				return m;
			});
		} else {
			this.messages.push(message);
		}

		// Use parameterized queries to prevent SQL injection
		this.ctx.storage.sql.exec(
			`INSERT INTO messages (id, user, userId, role, content, media, timestamp, replyTo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET content = ?, media = ?, timestamp = ?, replyTo = ?, userId = ?`,
			message.id,
			message.user,
			message.userId ?? null,
			message.role,
			message.content,
			message.media ?? null,
			message.timestamp ?? null,
			message.replyTo ? JSON.stringify(message.replyTo) : null,
			message.content,
			message.media ?? null,
			message.timestamp ?? null,
			message.replyTo ? JSON.stringify(message.replyTo) : null,
			message.userId ?? null,
		);
	}

	async onRequest(request: Request) {
		if (request.method === "DELETE") {
			this.ctx.storage.sql.exec(`DELETE FROM messages`);
			this.messages = [];
			this.broadcast(
				JSON.stringify({
					type: "all",
					messages: [],
				} satisfies Message),
			);
			return new Response("cleared", { status: 200 });
		}
		return super.onRequest(request);
	}

	async onMessage(connection: Connection, message: WSMessage) {
		const parsed = JSON.parse(message as string) as Message;
		const identity = connection.state as AccountInfo | null;

		if (parsed.type === "uploads-rule") {
			// owner-only action; forward to the Accounts DO which checks the session
			const res = await this.env.Accounts.get(
				this.env.Accounts.idFromName("registry"),
			).fetch("https://accounts/uploads-rule", {
				method: "POST",
				headers: { "x-partykit-room": "registry" },
				body: JSON.stringify({
					token: parsed.token,
					targetId: parsed.targetId,
					disabled: parsed.disabled,
				}),
			});
			let result: { ok: boolean; message: string; targetId: string };
			try {
				result = (await res.json()) as {
					ok: boolean;
					message: string;
					targetId: string;
				};
			} catch (e) {
				result = {
					ok: false,
					message: "Couldn't reach the accounts server.",
					targetId: parsed.targetId,
				};
			}
			connection.send(
				JSON.stringify({
					type: "uploads-rule-result",
					ok: result.ok,
					message: result.message,
					targetId: result.targetId,
				} satisfies Message),
			);
			return;
		}

		if (parsed.type === "typing-start" || parsed.type === "typing-stop") {
			if (!identity) return;
			if (parsed.type === "typing-start") {
				this.typingUsers.set(connection.id, identity.name);
			} else {
				this.typingUsers.delete(connection.id);
			}
			this.broadcastTyping([connection.id]);
			return;
		}

		if (parsed.type === "add" || parsed.type === "update") {
			if (!identity) return;
			if (parsed.media) {
				// file uploads can be disabled per account; check with the
				// accounts server on every media message so it applies live
				try {
					const check = await this.env.Accounts.get(
						this.env.Accounts.idFromName("registry"),
					).fetch("https://accounts/uploads-check", {
						method: "POST",
						headers: { "x-partykit-room": "registry" },
						body: identity.id,
					});
					const status = (await check.json()) as { disabled: boolean };
					if (status.disabled) {
						connection.send(
							JSON.stringify({
								type: "uploads-disabled",
							} satisfies Message),
						);
						return;
					}
				} catch (e) {
					// if the accounts server is unreachable, reject the upload
					// rather than letting it through
					connection.send(
						JSON.stringify({
							type: "uploads-disabled",
						} satisfies Message),
					);
					return;
				}
			}
			// the account name is authoritative - ignore whatever the client sent
			parsed.user = identity.name;
			parsed.userId = identity.id;
			// stamp the server time on the message (authoritative)
			parsed.timestamp = Date.now();

			// let's broadcast the raw message to everyone else
			this.broadcast(JSON.stringify(parsed));

			// let's update our local messages store
			this.saveMessage(parsed);
		}
	}

	onClose(connection: Connection) {
		if (this.typingUsers.delete(connection.id)) {
			this.broadcastTyping([connection.id]);
		}
	}
}

export class Accounts extends Server<Env> {
	static options = { hibernate: true };

	onStart() {
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL)`,
		);
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, account TEXT NOT NULL, created INTEGER NOT NULL)`,
		);
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS uploads_disabled (account_id TEXT PRIMARY KEY, created INTEGER NOT NULL)`,
		);
	}

	// accounts listed in the OWNER_ACCOUNT_IDS secret are the site owners.
	// the value only ever lives in the secret (or .dev.vars locally), never in
	// the repo, so nobody but the deployer can become an owner.
	private ownerIds(): string[] {
		const raw = (this.env.OWNER_ACCOUNT_IDS ?? "").trim();
		if (!raw) return [];
		return raw
			.split(",")
			.map((id) => id.trim())
			.filter(Boolean);
	}

	private isOwnerConfigured(): boolean {
		return this.ownerIds().length > 0;
	}

	private isOwnerAccount(accountId: string): boolean {
		return this.ownerIds().includes(accountId);
	}

	private isUploadsDisabled(accountId: string): boolean {
		const rows = this.ctx.storage.sql
			.exec(
				`SELECT 1 FROM uploads_disabled WHERE account_id = ?`,
				accountId,
			)
			.toArray();
		return rows.length > 0;
	}

	private async accountInfo(accountId: string): Promise<AccountInfo | null> {
		const rows = this.ctx.storage.sql
			.exec(`SELECT id, name FROM accounts WHERE id = ?`, accountId)
			.toArray() as Array<{ id: string; name: string }>;
		const row = rows[0];
		if (!row) return null;
		return {
			id: row.id,
			name: row.name,
			isOwner: this.isOwnerAccount(row.id),
			uploadsDisabled: this.isUploadsDisabled(row.id),
		};
	}

	// the one place that applies an uploads rule, shared by the chat socket
	// (forwarded) and the accounts socket (settings)
	private async applyUploadsRule(
		requesterToken: string,
		targetId: string,
		disabled: boolean,
	): Promise<{ ok: boolean; message: string; targetId: string }> {
		const requesterId = this.findAccountForToken(requesterToken);
		if (!requesterId) {
			return {
				ok: false,
				message: "Your session expired. Sign out and sign in again.",
				targetId,
			};
		}
		if (!this.isOwnerAccount(requesterId)) {
			return {
				ok: false,
				message: "Only the site owner can change upload permissions.",
				targetId,
			};
		}
		const target = await this.accountInfo(targetId);
		if (!target) {
			return { ok: false, message: "That account doesn't exist.", targetId };
		}
		if (disabled) {
			this.ctx.storage.sql.exec(
				`INSERT OR IGNORE INTO uploads_disabled (account_id, created) VALUES (?, ?)`,
				targetId,
				Date.now(),
			);
		} else {
			this.ctx.storage.sql.exec(
				`DELETE FROM uploads_disabled WHERE account_id = ?`,
				targetId,
			);
		}
		return {
			ok: true,
			message: disabled
				? `"${target.name}" can no longer send images or videos.`
				: `"${target.name}" can send images and videos again.`,
			targetId,
		};
	}

	private async deriveHash(password: string, salt: string): Promise<string> {
		const keyMaterial = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(password),
			"PBKDF2",
			false,
			["deriveBits"],
		);
		const bits = await crypto.subtle.deriveBits(
			{
				name: "PBKDF2",
				salt: new TextEncoder().encode(salt),
				iterations: 100000,
				hash: "SHA-256",
			},
			keyMaterial,
			256,
		);
		return Array.from(new Uint8Array(bits), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");
	}

	private newToken(): string {
		return (
			crypto.randomUUID().replace(/-/g, "") +
			crypto.randomUUID().replace(/-/g, "")
		);
	}

	private findAccountForToken(token: string): string | null {
		const rows = this.ctx.storage.sql
			.exec(`SELECT account FROM sessions WHERE token = ?`, token)
			.toArray() as Array<{ account: string }>;
		return rows[0]?.account ?? null;
	}

	async onMessage(connection: Connection, message: WSMessage) {
		const parsed = JSON.parse(message as string) as AccountMessage;

		if (parsed.type === "register" || parsed.type === "login") {
			if (typeof parsed.name !== "string") {
				connection.send(
					JSON.stringify({
						type: "error",
						code: "invalid-input",
						message: "Invalid name or password.",
					} satisfies AccountMessage),
				);
				return;
			}
			const name = parsed.name.trim().slice(0, 24);
			const isRegister = parsed.type === "register";
			if (
				!name ||
				parsed.password.length < 6 ||
				parsed.password.length > 128
			) {
				connection.send(
					JSON.stringify({
						type: "error",
						code: "invalid-input",
						message: isRegister
							? "Pick a name and a password of at least 6 characters."
							: "Invalid name or password.",
					} satisfies AccountMessage),
				);
				return;
			}

			if (isRegister) {
				const existing = this.ctx.storage.sql
					.exec(`SELECT id FROM accounts WHERE name = ?`, name)
					.toArray();
				if (existing.length > 0) {
					connection.send(
						JSON.stringify({
							type: "error",
							code: "name-taken",
							message: `The name "${name}" is already taken. Try another one.`,
						} satisfies AccountMessage),
					);
					return;
				}
				const id = crypto.randomUUID();
				const salt = crypto.randomUUID();
				const hash = await this.deriveHash(parsed.password, salt);
				try {
					this.ctx.storage.sql.exec(
						`INSERT INTO accounts (id, name, salt, hash, created) VALUES (?, ?, ?, ?, ?)`,
						id,
						name,
						salt,
						hash,
						Date.now(),
					);
				} catch (e) {
					// another connection claimed the name at the same time
					connection.send(
						JSON.stringify({
							type: "error",
							code: "name-taken",
							message: `The name "${name}" is already taken. Try another one.`,
						} satisfies AccountMessage),
					);
					return;
				}
				const token = this.newToken();
				this.ctx.storage.sql.exec(
					`INSERT INTO sessions (token, account, created) VALUES (?, ?, ?)`,
					token,
					id,
					Date.now(),
				);
			connection.send(
				JSON.stringify({
					type: "registered",
					id,
					name,
					token,
					remember: parsed.remember,
					isOwner: this.isOwnerAccount(id),
					uploadsDisabled: false,
					ownerConfigured: this.isOwnerConfigured(),
				} satisfies AccountMessage),
			);
			return;
		}

			const rows = this.ctx.storage.sql
				.exec(
					`SELECT id, salt, hash FROM accounts WHERE name = ?`,
					name,
				)
				.toArray() as Array<{ id: string; salt: string; hash: string }>;
			const row = rows[0];
			const hash = row ? await this.deriveHash(parsed.password, row.salt) : "";
			if (!row || hash !== row.hash) {
				connection.send(
					JSON.stringify({
						type: "error",
						code: "invalid",
						message: "Wrong name or password.",
					} satisfies AccountMessage),
				);
				return;
			}
			const token = this.newToken();
			this.ctx.storage.sql.exec(
				`INSERT INTO sessions (token, account, created) VALUES (?, ?, ?)`,
				token,
				row.id,
				Date.now(),
			);
			connection.send(
				JSON.stringify({
					type: "logged-in",
					id: row.id,
					name,
					token,
					remember: parsed.remember,
					isOwner: this.isOwnerAccount(row.id),
					uploadsDisabled: this.isUploadsDisabled(row.id),
					ownerConfigured: this.isOwnerConfigured(),
				} satisfies AccountMessage),
			);
			return;
		}

		if (parsed.type === "rename") {
			const accountId = this.findAccountForToken(parsed.token);
			if (!accountId) {
				connection.send(
					JSON.stringify({
						type: "error",
						code: "session",
						message:
							"Your session expired. Sign out and sign in again.",
					} satisfies AccountMessage),
				);
				return;
			}
			const newName = parsed.newName.trim().slice(0, 24);
			if (!newName) {
				connection.send(
					JSON.stringify({
						type: "error",
						code: "invalid-input",
						message: "Name can't be empty.",
					} satisfies AccountMessage),
				);
				return;
			}
			const dup = this.ctx.storage.sql
				.exec(
					`SELECT id FROM accounts WHERE name = ? AND id != ?`,
					newName,
					accountId,
				)
				.toArray();
			if (dup.length > 0) {
				connection.send(
					JSON.stringify({
						type: "error",
						code: "name-taken",
						message: `The name "${newName}" is already taken. Try another one.`,
					} satisfies AccountMessage),
				);
				return;
			}
			this.ctx.storage.sql.exec(
				`UPDATE accounts SET name = ? WHERE id = ?`,
				newName,
				accountId,
			);
			connection.send(
				JSON.stringify({
					type: "renamed",
					name: newName,
				} satisfies AccountMessage),
			);
			return;
		}

		if (parsed.type === "logout") {
			this.ctx.storage.sql.exec(
				`DELETE FROM sessions WHERE token = ?`,
				parsed.token,
			);
			return;
		}

		if (parsed.type === "uploads-rule") {
			const result = await this.applyUploadsRule(
				parsed.token,
				parsed.targetId,
				parsed.disabled,
			);
			connection.send(
				JSON.stringify({
					type: "uploads-rule-done",
					ok: result.ok,
					message: result.message,
					targetId: result.targetId,
				} satisfies AccountMessage),
			);
			return;
		}

		if (parsed.type === "uploads-restricted-list") {
			const accountId = this.findAccountForToken(parsed.token);
			if (!accountId || !this.isOwnerAccount(accountId)) return;
			const rows = this.ctx.storage.sql
				.exec(
					`SELECT a.id, a.name FROM uploads_disabled u JOIN accounts a ON a.id = u.account_id ORDER BY a.name`,
				)
				.toArray() as Array<{ id: string; name: string }>;
			connection.send(
				JSON.stringify({
					type: "uploads-restricted",
					accounts: rows.map((r) => ({
						id: r.id,
						name: r.name,
						isOwner: false,
						uploadsDisabled: true,
					})),
				} satisfies AccountMessage),
			);
			return;
		}
	}

	async onRequest(request: Request) {
		if (
			request.method === "POST" &&
			new URL(request.url).pathname.endsWith("/resolve")
		) {
			const token = (await request.text()).trim();
			const accountId = token ? this.findAccountForToken(token) : null;
			if (!accountId) return new Response("invalid session", { status: 401 });
			const info = await this.accountInfo(accountId);
			if (!info) return new Response("invalid session", { status: 401 });
			return Response.json(info satisfies AccountInfo);
		}

		if (
			request.method === "POST" &&
			new URL(request.url).pathname.endsWith("/uploads-rule")
		) {
			let body: { token?: string; targetId?: string; disabled?: boolean };
			try {
				body = (await request.json()) as {
					token?: string;
					targetId?: string;
					disabled?: boolean;
				};
			} catch (e) {
				return Response.json(
					{ ok: false, message: "Invalid request." },
					{ status: 400 },
				);
			}
			if (!body.token || !body.targetId || typeof body.disabled !== "boolean") {
				return Response.json(
					{ ok: false, message: "Invalid request." },
					{ status: 400 },
				);
			}
			return Response.json(
				await this.applyUploadsRule(body.token, body.targetId, body.disabled),
			);
		}

		if (
			request.method === "POST" &&
			new URL(request.url).pathname.endsWith("/uploads-check")
		) {
			const accountId = (await request.text()).trim();
			const rows = this.ctx.storage.sql
				.exec(`SELECT id FROM accounts WHERE id = ?`, accountId)
				.toArray();
			if (rows.length === 0) {
				return Response.json({ disabled: true }, { status: 200 });
			}
			return Response.json({ disabled: this.isUploadsDisabled(accountId) });
		}

		return super.onRequest(request);
	}
}

export class Rooms extends Server<Env> {
	static options = { hibernate: true };

	rooms = [] as string[];

	onStart() {
		this.ctx.storage.sql.exec(
			`CREATE TABLE IF NOT EXISTS rooms (name TEXT PRIMARY KEY)`,
		);
		this.rooms = (
			this.ctx.storage.sql
				.exec(`SELECT name FROM rooms ORDER BY name`)
				.toArray() as Array<{ name: string }>
		).map((row) => row.name);
	}

	broadcastRooms() {
		this.broadcast(
			JSON.stringify({
				type: "rooms",
				rooms: this.rooms,
			} satisfies RoomsMessage),
		);
	}

	onConnect(connection: Connection) {
		connection.send(
			JSON.stringify({
				type: "rooms",
				rooms: this.rooms,
			} satisfies RoomsMessage),
		);
	}

	createRoom(rawName: string) {
		const name = normalizeRoomName(rawName);
		if (!name || this.rooms.includes(name)) return;
		this.rooms.push(name);
		this.rooms.sort();
		this.ctx.storage.sql.exec(`INSERT INTO rooms (name) VALUES (?)`, name);
		this.broadcastRooms();
	}

	renameRoom(oldName: string, rawNewName: string) {
		const newName = normalizeRoomName(rawNewName);
		if (!newName || newName === oldName || this.rooms.includes(newName)) {
			return;
		}
		if (!this.rooms.includes(oldName)) return;
		this.rooms = this.rooms.filter((r) => r !== oldName);
		this.rooms.push(newName);
		this.rooms.sort();
		this.ctx.storage.sql.exec(`DELETE FROM rooms WHERE name = ?`, oldName);
		this.ctx.storage.sql.exec(`INSERT INTO rooms (name) VALUES (?)`, newName);
		this.broadcastRooms();
	}

	deleteRoom(name: string) {
		if (!this.rooms.includes(name)) return;
		this.rooms = this.rooms.filter((r) => r !== name);
		this.ctx.storage.sql.exec(`DELETE FROM rooms WHERE name = ?`, name);
		// wipe the chat history for this room for real
		try {
			this.env.Chat.get(this.env.Chat.idFromName(name)).fetch(
				"https://chat/clear",
				{
					method: "DELETE",
					headers: { "x-partykit-room": name },
				},
			);
		} catch (e) {
			console.error(`Failed to clear chat history for ${name}`, e);
		}
		this.broadcastRooms();
	}

	onMessage(connection: Connection, message: WSMessage) {
		const parsed = JSON.parse(message as string) as RoomsMessage;
		if (parsed.type === "create") {
			this.createRoom(parsed.name);
		} else if (parsed.type === "rename") {
			this.renameRoom(parsed.oldName, parsed.newName);
		} else if (parsed.type === "delete") {
			this.deleteRoom(parsed.name);
		}
	}
}

export default {
	async fetch(request, env) {
		return (
			(await routePartykitRequest(request, { ...env })) ||
			env.ASSETS.fetch(request)
		);
	},
} satisfies ExportedHandler<Env>;