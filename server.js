require("dotenv").config();
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const server = http.createServer(app);

// ─── Supabase Setup ───────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ─── CORS ────────────────────────────────────────────────────────────────────
const allowedOrigins = [
  process.env.FRONTEND_URL || "http://localhost:5173",
];

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(express.json());

// ─── Socket.io ───────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
    credentials: true,
  },
});

// Track online users: { socketId -> { username, room } }
const onlineUsers = {};

io.on("connection", (socket) => {
  console.log(`✅ User connected: ${socket.id}`);

  // User joins a room (roomId = sorted combo of two usernames e.g. "alice_bob")
  socket.on("join_room", ({ username, room }) => {
    socket.join(room);
    onlineUsers[socket.id] = { username, room };
    console.log(`👤 ${username} joined room: ${room}`);

    // Notify the room
    socket.to(room).emit("user_status", {
      type: "joined",
      username,
      message: `${username} is online`,
    });
  });

  // Send message
  socket.on("send_message", async ({ room, sender, receiver, content }) => {
    const timestamp = new Date().toISOString();
    const msgPayload = { room, sender, receiver, content, created_at: timestamp };

    // Save to Supabase
    const { error } = await supabase.from("messages").insert([msgPayload]);
    if (error) {
      console.error("Supabase insert error:", error.message);
      socket.emit("error", { message: "Message save failed" });
      return;
    }

    // Broadcast to everyone in room (including sender)
    io.to(room).emit("receive_message", msgPayload);
  });

  // Typing indicator
  socket.on("typing", ({ room, username, isTyping }) => {
    socket.to(room).emit("typing_status", { username, isTyping });
  });

  socket.on("disconnect", () => {
    const user = onlineUsers[socket.id];
    if (user) {
      socket.to(user.room).emit("user_status", {
        type: "left",
        username: user.username,
        message: `${user.username} went offline`,
      });
      delete onlineUsers[socket.id];
    }
    console.log(`❌ User disconnected: ${socket.id}`);
  });
});

// ─── REST API ─────────────────────────────────────────────────────────────────

// Get message history for a room
app.get("/messages/:room", async (req, res) => {
  const { room } = req.params;
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("room", room)
    .order("created_at", { ascending: true })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ─── /healthz — UptimeRobot is se ping karega, server awake rahega ────────────
app.get("/healthz", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

// ─── Start Server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
