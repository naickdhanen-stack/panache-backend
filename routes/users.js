const express = require('express');
const { supabaseAdmin } = require('../config/supabase');
const { authenticateToken, authorizeRoles } = require('../middleware/auth');

const router = express.Router();

// Get all users (Admin and Superuser only)
router.get('/', authenticateToken, authorizeRoles('admin', 'superuser'), async (req, res) => {
  try {
    const { data: users, error } = await supabaseAdmin
      .from('users')
      .select('id, username, role, department, is_active, created_at')
      .order('created_at', { ascending: false });

    if (error) throw error;

    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get single user
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const { data: user, error } = await supabaseAdmin
      .from('users')
      .select('id, username, role, department, is_active, created_at')
      .eq('id', req.params.id)
      .single();

    if (error) throw error;

    // Users can only view their own profile unless admin/superuser
    if (req.user.id !== user.id && !['admin', 'superuser'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Create user (Admin and Superuser only)
router.post('/', authenticateToken, authorizeRoles('admin', 'superuser'), async (req, res) => {
  const { username, password, role, department } = req.body;

  // Validate input
  if (!username || !password || !role || !department) {
    return res.status(400).json({ error: 'All fields are required' });
  }

  if (!['admin', 'superuser', 'user'].includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  try {
    // Check if username already exists
    const { data: existingUser } = await supabaseAdmin
      .from('users')
      .select('username')
      .eq('username', username)
      .single();

    if (existingUser) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    // Insert new user (password will be hashed by database trigger)
    const { data: newUser, error } = await supabaseAdmin
      .rpc('create_user', {
        p_username: username,
        p_password: password,
        p_role: role,
        p_department: department,
        p_created_by: req.user.id
      });

    if (error) throw error;

    res.status(201).json({
      message: 'User created successfully',
      user: newUser
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Update user (Admin only)
router.put('/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const { username, role, department, is_active } = req.body;
  const userId = req.params.id;

  try {
    const updateData = {};
    if (username) updateData.username = username;
    if (role) updateData.role = role;
    if (department) updateData.department = department;
    if (typeof is_active !== 'undefined') updateData.is_active = is_active;

    const { data: updatedUser, error } = await supabaseAdmin
      .from('users')
      .update(updateData)
      .eq('id', userId)
      .select('id, username, role, department, is_active')
      .single();

    if (error) throw error;

    res.json({
      message: 'User updated successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Archive/Disable user (Admin only)
router.patch('/:id/archive', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const userId = req.params.id;

  try {
    const { data: updatedUser, error } = await supabaseAdmin
      .from('users')
      .update({ is_active: false })
      .eq('id', userId)
      .select('id, username, is_active')
      .single();

    if (error) throw error;

    res.json({
      message: 'User archived successfully',
      user: updatedUser
    });
  } catch (error) {
    console.error('Error archiving user:', error);
    res.status(500).json({ error: 'Failed to archive user' });
  }
});

// Delete user (Admin only)
router.delete('/:id', authenticateToken, authorizeRoles('admin'), async (req, res) => {
  const userId = req.params.id;

  // Prevent deleting own account
  if (userId === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }

  try {
    const { error } = await supabaseAdmin
      .from('users')
      .delete()
      .eq('id', userId);

    if (error) throw error;

    res.json({ message: 'User deleted successfully' });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;