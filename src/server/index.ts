import {
	type Connection,
	Server,
	type WSMessage,
	routePartykitRequest,
} from "partyserver";

import {
	normalizeRoomName,
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
			`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, user TEXT, role TEXT, content TEXT, media TEXT, timestamp INTEGER, replyTo TEXT)`,
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

		// load the messages from the database
		this.messages = (
			this.ctx.storage.sql
				.exec(`SELECT * FROM messages`)
				.toArray() as Array<Record<string, unknown>>
		).map((row) => ({
			id: row.id as string,
			user: row.user as string,
			role: row.role as "user" | "assistant",
			content: row.content as string,
			media: (row.media as string) ?? undefined,
			timestamp: (row.timestamp as number) ?? undefined,
			replyTo: row.replyTo
				? (JSON.parse(row.replyTo as string) as ReplyTo)
				: undefined,
		}));
	}

	onConnect(connection: Connection) {
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
			`INSERT INTO messages (id, user, role, content, media, timestamp, replyTo) VALUES (?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT (id) DO UPDATE SET content = ?, media = ?, timestamp = ?, replyTo = ?`,
			message.id,
			message.user,
			message.role,
			message.content,
			message.media ?? null,
			message.timestamp ?? null,
			message.replyTo ? JSON.stringify(message.replyTo) : null,
			message.content,
			message.media ?? null,
			message.timestamp ?? null,
			message.replyTo ? JSON.stringify(message.replyTo) : null,
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

	onMessage(connection: Connection, message: WSMessage) {
		const parsed = JSON.parse(message as string) as Message;

		if (parsed.type === "typing-start") {
			this.typingUsers.set(connection.id, parsed.user);
			this.broadcastTyping([connection.id]);
			return;
		}
		if (parsed.type === "typing-stop") {
			this.typingUsers.delete(connection.id);
			this.broadcastTyping([connection.id]);
			return;
		}

		// stamp the server time on the message (authoritative)
		if (parsed.type === "add" || parsed.type === "update") {
			parsed.timestamp = Date.now();
		}

		// let's broadcast the raw message to everyone else
		this.broadcast(JSON.stringify(parsed));

		// let's update our local messages store
		if (parsed.type === "add" || parsed.type === "update") {
			this.saveMessage(parsed);
		}
	}

	onClose(connection: Connection) {
		if (this.typingUsers.delete(connection.id)) {
			this.broadcastTyping([connection.id]);
		}
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
				{ method: "DELETE" },
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