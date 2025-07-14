<!-- The login form is already set to submit to your PHP file via action="/action_page.php" and method="post".
To connect it, ensure you have a PHP file named action_page.php in your server directory.
Example PHP code for action_page.php:

<?php
if ($_SERVER["REQUEST_METHOD"] == "POST") {
  $username = $_POST['uname'];
  $password = $_POST['psw'];

  // Example: Replace with your own authentication logic
  if ($username === "admin" && $password === "password123") {
    echo "Login successful. Welcome, $username!";
  } else {
    echo "Invalid username or password.";
  }
}
?>

Make sure your server supports PHP and the form action path is correct.
-->