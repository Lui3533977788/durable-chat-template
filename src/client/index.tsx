import { createRoot } from "react-dom/client";
import { usePartySocket } from "partysocket/react";
import React, { useState } from "react";
import {
	BrowserRouter,
	Routes,
	Route,
	Navigate,
	Link,
	useNavigate,
	useParams,
} from "react-router";
import { nanoid } from "nanoid";

import {
	normalizeRoomName,
	type ChatMessage,
	type Message,
	type RoomsMessage,
} from "../shared";

const USERNAME_KEY = "durable-chat-username";

function ChatRoom({ room, name }: { room: string; name: string }) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);

	const socket = usePartySocket({
		party: "chat",
		room,
		onMessage: (evt) => {
			const message = JSON.parse(evt.data as string) as Message;
			if (message.type === "add") {
				const foundIndex = messages.findIndex((m) => m.id === message.id);
				if (foundIndex === -1) {
					setMessages((messages) => [
						...messages,
						{
							id: message.id,
							content: message.content,
							user: message.user,
							role: message.role,
						},
					]);
				} else {
					setMessages((messages) => {
						return messages
							.slice(0, foundIndex)
							.concat({
								id: message.id,
								content: message.content,
								user: message.user,
								role: message.role,
							})
							.concat(messages.slice(foundIndex + 1));
					});
				}
			} else if (message.type === "update") {
				setMessages((messages) =>
					messages.map((m) =>
						m.id === message.id
							? {
									id: message.id,
									content: message.content,
									user: message.user,
									role: message.role,
								}
							: m,
					),
				);
			} else {
				setMessages(message.messages);
			}
		},
	});

	return (
		<div className="chat">
			<div className="chat-header">
				<span>
					<b>#{room}</b>
				</span>
			</div>
			<div className="messages">
				{messages.map((message) => (
					<div
						key={message.id}
						className={`message ${message.user === name ? "self" : ""}`}
					>
						<div className="user">{message.user}</div>
						<div className="bubble">{message.content}</div>
					</div>
				))}
			</div>
			<form
				className="chat-input"
				onSubmit={(e) => {
					e.preventDefault();
					const content = e.currentTarget.elements.namedItem(
						"content",
					) as HTMLInputElement;
					const chatMessage: ChatMessage = {
						id: nanoid(8),
						content: content.value,
						user: name,
						role: "user",
					};
					setMessages((messages) => [...messages, chatMessage]);

					socket.send(
						JSON.stringify({
							type: "add",
							...chatMessage,
						} satisfies Message),
					);

					content.value = "";
				}}
			>
				<input
					type="text"
					name="content"
					placeholder={`Message ${name}...`}
					autoComplete="off"
				/>
				<button type="submit">Send</button>
			</form>
		</div>
	);
}

function Sidebar({
	name,
	rooms,
	activeRoom,
	onCreateRoom,
	onChangeName,
}: {
	name: string;
	rooms: string[];
	activeRoom?: string;
	onCreateRoom: (name: string) => void;
	onChangeName: () => void;
}) {
	const [newRoom, setNewRoom] = useState("");

	return (
		<aside className="sidebar">
			<div className="sidebar-header">Chat</div>
			<div className="sidebar-section">ROOMS</div>
			<ul className="room-list">
				{rooms.map((room) => (
					<li key={room}>
						<Link
							to={`/${room}`}
							className={`room-link ${room === activeRoom ? "active" : ""}`}
						>
							# {room}
						</Link>
					</li>
				))}
			</ul>
			<form
				className="new-room"
				onSubmit={(e) => {
					e.preventDefault();
					if (newRoom.trim()) {
						onCreateRoom(newRoom.trim());
						setNewRoom("");
					}
				}}
			>
				<input
					type="text"
					value={newRoom}
					onChange={(e) => setNewRoom(e.target.value)}
					placeholder="New room..."
					autoComplete="off"
					maxLength={24}
				/>
				<button type="submit" aria-label="Create room">
					+
				</button>
			</form>
			<div className="sidebar-footer">
				<span title={name}>{name}</span>
				<button type="button" onClick={onChangeName}>
					Change name
				</button>
			</div>
		</aside>
	);
}

function App() {
	const [name, setName] = useState(
		() => localStorage.getItem(USERNAME_KEY) ?? "",
	);
	const [rooms, setRooms] = useState<string[]>([]);
	const { room } = useParams();
	const navigate = useNavigate();

	const roomsSocket = usePartySocket({
		party: "rooms",
		room: "registry",
		onMessage: (evt) => {
			const message = JSON.parse(evt.data as string) as RoomsMessage;
			if (message.type === "rooms") {
				setRooms(message.rooms);
			}
		},
	});

	if (!name) {
		return (
			<div className="chat">
				<div className="welcome">
					<h2>Chat</h2>
					<p>Pick a username to start chatting with your friends.</p>
					<form
						onSubmit={(e) => {
							e.preventDefault();
							const input = e.currentTarget.elements.namedItem(
								"username",
							) as HTMLInputElement;
							const username = input.value.trim();
							if (username) {
								localStorage.setItem(USERNAME_KEY, username);
								setName(username);
							}
						}}
					>
						<input
							type="text"
							name="username"
							placeholder="Enter your username..."
							autoComplete="off"
							maxLength={24}
						/>
						<button type="submit">Join</button>
					</form>
				</div>
			</div>
		);
	}

	return (
		<div className="app-layout">
			<Sidebar
				name={name}
				rooms={rooms}
				activeRoom={room}
				onCreateRoom={(value) => {
					const normalized = normalizeRoomName(value);
					if (!normalized) return;
					roomsSocket.send(
						JSON.stringify({
							type: "create",
							name: normalized,
						} satisfies RoomsMessage),
					);
					navigate(`/${normalized}`);
				}}
				onChangeName={() => {
					localStorage.removeItem(USERNAME_KEY);
					setName("");
				}}
			/>
			{room ? (
				<ChatRoom room={room} name={name} />
			) : (
				<div className="empty-state">
					<h3>Welcome to Chat</h3>
					<p>
						Pick a room on the left, or create a new one to start
						chatting.
					</p>
				</div>
			)}
		</div>
	);
}

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
createRoot(document.getElementById("root")!).render(
	<BrowserRouter>
		<Routes>
			<Route path="/" element={<App />} />
			<Route path="/:room" element={<App />} />
			<Route path="*" element={<Navigate to="/" />} />
		</Routes>
	</BrowserRouter>,
);