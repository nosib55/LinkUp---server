const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const { MongoClient, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

/* ================= FIREBASE ADMIN ================= */
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      require("./serviceAccountKey.json")
    ),
  });
}

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
  console.log("MongoDB connected");
});

/* ================= AUTH MIDDLEWARE (FIREBASE) ================= */

const auth = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json("No token");

  const token = header.split(" ")[1];

  try {
    const decoded = await admin.auth().verifyIdToken(token);

    let user = await Users.findOne({ email: decoded.email });

    // Auto-create user in DB if not exists
    if (!user) {
      const newUser = {
        fullName: decoded.name || "",
        email: decoded.email,
        role: "user",
        banned: false,
        profileImage: "",
        coverImage: "",
        bio: "",
        location: "",
        dateOfBirth: null,
        followers: [],
        following: [],
        createdAt: new Date(),
      };

      const result = await Users.insertOne(newUser);
      user = { ...newUser, _id: result.insertedId };
    }

    if (user.banned) return res.status(403).json("User banned");

    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json("Invalid Firebase token");
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
    params: { key: process.env.IMGBB_API_KEY, image: base64 },
  });
  return res.data.data.url;
};

/* ================= NOTIFICATION HELPER ================= */

const createNotification = async ({
  type,
  sender,
  receiver,
  postId = null,
}) => {
  if (sender.toString() === receiver.toString()) return;

  await Notifications.insertOne({
    type,
    sender,
    receiver,
    postId,
    read: false,
    createdAt: new Date(),
  });
};

/* ================= USER ================= */

app.post("/api/register", async (req, res) => {
  // Firebase already created the user
  // This endpoint only stores profile data
  await Users.updateOne(
    { email: req.body.email },
    {
      $set: {
        fullName: req.body.fullName,
        email: req.body.email,
      },
    },
    { upsert: true }
  );

  res.json("User profile saved");
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
  await Users.updateOne(
    { _id: req.user._id },
    { $set: { profileImage: image } }
  );
  res.json(image);
});

app.put("/api/profile/cover", auth, upload.single("image"), async (req, res) => {
  const image = await uploadToImgBB(req.file.buffer);
  await Users.updateOne(
    { _id: req.user._id },
    { $set: { coverImage: image } }
  );
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
    receiver: targetId,
  });

  res.json("Followed");
});

/* ================= POSTS ================= */

app.post("/api/posts", auth, upload.single("image"), async (req, res) => {
  try {
    const image = req.file ? await uploadToImgBB(req.file.buffer) : null;

    const post = {
      content: req.body.content,
      image,
      author: req.user._id,
      likes: [],
      createdAt: new Date(),
    };

    const result = await Posts.insertOne(post);

    // ✅ send populated author
    res.json({
      ...post,
      _id: result.insertedId,
      author: {
        _id: req.user._id,
        fullName: req.user.fullName,
        profileImage: req.user.profileImage,
      },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json("Post creation failed");
  }
});

/* ================= COMMENTS ================= */

app.post("/api/posts/:id/comments", auth, async (req, res) => {
  const postId = new ObjectId(req.params.id);
  const post = await Posts.findOne({ _id: postId });

  const comment = {
    text: req.body.text,
    postId,
    author: req.user._id,
    createdAt: new Date(),
  };

  await Comments.insertOne(comment);

  await createNotification({
    type: "comment",
    sender: req.user._id,
    receiver: post.author,
    postId,
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

/* ================= ADMIN ================= */

app.put("/api/admin/users/:id/ban", auth, adminOnly, async (req, res) => {
  await Users.updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: { banned: true } }
  );
  res.json("User banned");
});

/* ================= SERVER ================= */

app.listen(process.env.PORT, () => {
  console.log("LINK UP backend running on port " + process.env.PORT);
});
