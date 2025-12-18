const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const { MongoClient, ObjectId } = require("mongodb");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

/* ================= DATABASE ================= */

const client = new MongoClient(process.env.MONGO_URI);
let db, Users, Posts, Comments, Reports, Notifications;

client.connect().then(() => {
  db = client.db("linkup");
  Users = db.collection("users");
  Posts = db.collection("posts");
  Comments = db.collection("comments");
  Reports = db.collection("reports");
  Notifications = db.collection("notifications");
  console.log("MongoDB connected (native)");
});

/* ================= MIDDLEWARE ================= */

const auth = async (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json("No token");

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await Users.findOne({ _id: new ObjectId(decoded.id) });
    if (!user || user.banned) return res.status(403).json("Access denied");
    req.user = user;
    next();
  } catch {
    res.status(401).json("Invalid token");
  }
};

const adminOnly = (req, res, next) => {
  if (req.user.role !== "admin") return res.status(403).json("Admin only");
  next();
};

const upload = multer({ storage: multer.memoryStorage() });

/* ================= IMAGE UPLOAD ================= */

const uploadToImgBB = async (buffer) => {
  const base64 = buffer.toString("base64");
  const res = await axios.post("https://api.imgbb.com/1/upload", null, {
    params: { key: process.env.IMGBB_API_KEY, image: base64 }
  });
  return res.data.data.url;
};

/* ================= NOTIFICATION HELPER ================= */

const createNotification = async ({ type, sender, receiver, postId = null }) => {
  if (sender.toString() === receiver.toString()) return;

  await Notifications.insertOne({
    type,
    sender,
    receiver,
    postId,
    read: false,
    createdAt: new Date()
  });
};

/* ================= AUTH ================= */

app.post("/api/register", async (req, res) => {
  const hash = await bcrypt.hash(req.body.password, 10);

  await Users.insertOne({
    username: req.body.username,
    email: req.body.email,
    password: hash,

    role: "user",
    banned: false,

    profileImage: "",
    coverImage: "",
    bio: "",
    location: "",
    dateOfBirth: null,

    followers: [],
    following: [],

    createdAt: new Date()
  });

  res.json("User registered");
});

app.post("/api/login", async (req, res) => {
  const user = await Users.findOne({ email: req.body.email });
  if (!user) return res.status(400).json("Invalid credentials");

  const valid = await bcrypt.compare(req.body.password, user.password);
  if (!valid) return res.status(400).json("Invalid credentials");

  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
  res.json({ token, user });
});

/* ================= PROFILE ================= */

app.get("/api/me", auth, async (req, res) => {
  const posts = await Posts.find({ author: req.user._id }).toArray();
  res.json({ user: req.user, posts });
});

app.put("/api/profile", auth, async (req, res) => {
  await Users.updateOne({ _id: req.user._id }, { $set: req.body });
  res.json("Profile updated");
});

app.put("/api/profile/avatar", auth, upload.single("image"), async (req, res) => {
  const image = await uploadToImgBB(req.file.buffer);
  await Users.updateOne({ _id: req.user._id }, { $set: { profileImage: image } });
  res.json(image);
});

app.put("/api/profile/cover", auth, upload.single("image"), async (req, res) => {
  const image = await uploadToImgBB(req.file.buffer);
  await Users.updateOne({ _id: req.user._id }, { $set: { coverImage: image } });
  res.json(image);
});

/* ================= FOLLOW ================= */

app.post("/api/follow/:id", auth, async (req, res) => {
  const targetId = new ObjectId(req.params.id);

  if (targetId.toString() === req.user._id.toString())
    return res.status(400).json("Cannot follow self");

  await Users.updateOne(
    { _id: req.user._id },
    { $addToSet: { following: targetId } }
  );

  await Users.updateOne(
    { _id: targetId },
    { $addToSet: { followers: req.user._id } }
  );

  await createNotification({
    type: "follow",
    sender: req.user._id,
    receiver: targetId
  });

  res.json("Followed");
});

app.post("/api/unfollow/:id", auth, async (req, res) => {
  const targetId = new ObjectId(req.params.id);

  await Users.updateOne(
    { _id: req.user._id },
    { $pull: { following: targetId } }
  );

  await Users.updateOne(
    { _id: targetId },
    { $pull: { followers: req.user._id } }
  );

  res.json("Unfollowed");
});

/* ================= POSTS ================= */

app.post("/api/posts", auth, upload.single("image"), async (req, res) => {
  const image = req.file ? await uploadToImgBB(req.file.buffer) : null;

  const post = {
    content: req.body.content,
    image,
    author: req.user._id,
    likes: [],
    createdAt: new Date()
  };

  await Posts.insertOne(post);
  res.json(post);
});

app.get("/api/posts", async (req, res) => {
  const posts = await Posts.find().sort({ createdAt: -1 }).toArray();
  res.json(posts);
});

app.put("/api/posts/:id/like", auth, async (req, res) => {
  const postId = new ObjectId(req.params.id);
  const post = await Posts.findOne({ _id: postId });

  if (!post.likes.some(id => id.toString() === req.user._id.toString())) {
    await Posts.updateOne(
      { _id: postId },
      { $addToSet: { likes: req.user._id } }
    );

    await createNotification({
      type: "like",
      sender: req.user._id,
      receiver: post.author,
      postId
    });
  }

  res.json("Liked");
});

/* ================= COMMENTS ================= */

app.post("/api/posts/:id/comments", auth, async (req, res) => {
  const postId = new ObjectId(req.params.id);
  const post = await Posts.findOne({ _id: postId });

  const comment = {
    text: req.body.text,
    postId,
    author: req.user._id,
    createdAt: new Date()
  };

  await Comments.insertOne(comment);

  await createNotification({
    type: "comment",
    sender: req.user._id,
    receiver: post.author,
    postId
  });

  res.json(comment);
});

/* ================= NOTIFICATIONS ================= */

app.get("/api/notifications", auth, async (req, res) => {
  const list = await Notifications.find({ receiver: req.user._id })
    .sort({ createdAt: -1 })
    .toArray();

  res.json(list);
});

app.put("/api/notifications/read-all", auth, async (req, res) => {
  await Notifications.updateMany(
    { receiver: req.user._id },
    { $set: { read: true } }
  );
  res.json("All read");
});

/* ================= ADMIN ================= */

app.put("/api/admin/users/:id/ban", auth, adminOnly, async (req, res) => {
  await Users.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { banned: true } }
  );
  res.json("User banned");
});

app.delete("/api/admin/posts/:id", auth, adminOnly, async (req, res) => {
  await Posts.deleteOne({ _id: new ObjectId(req.params.id) });
  await Comments.deleteMany({ postId: new ObjectId(req.params.id) });
  res.json("Post removed");
});

/* ================= SERVER ================= */

app.listen(process.env.PORT, () => {
  console.log("LINK UP backend running on port " + process.env.PORT);
});
