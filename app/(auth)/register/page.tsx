import type { Metadata } from "next";
import { RegisterForm } from "./register-form";

export const metadata: Metadata = {
  title: "Create your account",
  description: "Create your PrepGrade account.",
};

export default function RegisterPage() {
  return <RegisterForm />;
}
